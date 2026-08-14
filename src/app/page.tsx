import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, applications, dismissals } from "@/db/schema";
import { companies } from "@/lib/companies";
import { ageLabel, daysSince, timeAgo } from "@/lib/time";
import { formatYoe } from "@/lib/yoe";
import { queueSnapshot } from "@/lib/queue";
import { FILTER_DEFAULTS } from "@/lib/filter-defaults";
import { dismissJob, refreshNow, restoreJob, trackJob } from "./actions";
import { SubmitButton } from "./SubmitButton";
import { Filters } from "./Filters";
import { RunStatus } from "./RunStatus";

export const dynamic = "force-dynamic";

type Search = {
  q?: string;
  source?: string;
  remote?: string;
  minScore?: string;
  sort?: string;
  elig?: string;
  maxAge?: string;
  /** "hide" drops roles already in the tracker. */
  tracked?: string;
  /** Max years of experience the posting asks for; "" for any. */
  maxYoe?: string;
  /** "show" surfaces roles you've dismissed instead of hiding them. */
  dismissed?: string;
  /** 1-based page number. */
  page?: string;
};

function scoreClass(s: number) {
  return s >= 70 ? "high" : s >= 45 ? "mid" : "low";
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/**
 * Rows per page. The board runs to four figures now, and the old flat cap of 250
 * silently hid the tail — a filtered count that says "250+ (capped)" can't tell
 * you whether you've seen everything.
 */
const PAGE_SIZE = 50;

/** Rebuild the current query string with `next` applied. */
function pageHref(sp: Search, next: Partial<Search>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...next })) {
    if (v) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

/** Derived so adding a connector updates the masthead on its own. */
const boards = [...new Set(companies.map((c) => c.ats))];

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  if (!db) return <SetupPanel />;

  const sp = await searchParams;
  const minScore = Number(sp.minScore ?? FILTER_DEFAULTS.minScore);
  const sort = sp.sort === "recent" || sp.sort === "new" ? sp.sort : "score";
  const elig = sp.elig ?? FILTER_DEFAULTS.elig;

  const filters: SQL[] = [gte(jobs.score, isNaN(minScore) ? 0 : minScore)];
  if (sp.q) {
    const like = `%${sp.q}%`;
    filters.push(or(ilike(jobs.title, like), ilike(jobs.company, like))!);
  }
  if (sp.source) filters.push(eq(jobs.source, sp.source));
  if (sp.remote === "1") filters.push(eq(jobs.remote, true));

  // Hide what's already in the pipeline, so the board reads as "what's left to
  // do". Done in SQL rather than by filtering the results: the query is capped
  // at 250 rows, so dropping them afterwards would silently shrink the page and
  // make the count a lie.
  if (sp.tracked === "hide") {
    filters.push(
      notExists(
        db
          .select({ one: sql`1` })
          .from(applications)
          .where(
            and(
              eq(applications.source, jobs.source),
              eq(applications.externalId, jobs.externalId),
            ),
          ),
      ),
    );
  }

  // Roles you'd be screened out of are hidden unless explicitly asked for.
  if (elig === "eligible") filters.push(eq(jobs.eligibility, "eligible"));
  else if (elig !== "all")
    filters.push(inArray(jobs.eligibility, ["eligible", "longshot"]));

  const maxAge = Number(sp.maxAge);
  if (sp.maxAge && !isNaN(maxAge)) {
    filters.push(gte(jobs.postedAt, daysAgo(maxAge)));
  }

  // Experience ceiling. Rows with no stated requirement are kept, not dropped —
  // two thirds of aggregator postings say nothing, and treating silence as
  // "asks for too much" would hide most of the board.
  const maxYoe = Number(sp.maxYoe);
  if (sp.maxYoe && !isNaN(maxYoe)) {
    filters.push(or(isNull(jobs.yoeMin), lte(jobs.yoeMin, maxYoe))!);
  }

  // Dismissed roles are hidden by default. Same notExists shape as the tracker
  // filter, and for the same reason: doing it in SQL keeps the count honest.
  if (sp.dismissed !== "show") {
    filters.push(
      notExists(
        db
          .select({ one: sql`1` })
          .from(dismissals)
          .where(
            and(
              eq(dismissals.source, jobs.source),
              eq(dismissals.externalId, jobs.externalId),
            ),
          ),
      ),
    );
  }

  const order =
    sort === "recent"
      ? [desc(jobs.postedAt), desc(jobs.score)]
      : sort === "new"
        ? [desc(jobs.firstSeenAt), desc(jobs.score)]
        : [desc(jobs.score), desc(jobs.postedAt)];

  const page = Math.max(1, Number(sp.page) || 1);

  const [rows, [matched], tracked, dismissedRows, [stats], queue] = await Promise.all([
    db
      .select()
      .from(jobs)
      .where(and(...filters))
      .orderBy(...order)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    // Counted with the same predicates as the page query, so "X matching roles"
    // means the filtered total rather than the size of this slice.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(...filters)),
    db
      .select({ source: applications.source, externalId: applications.externalId })
      .from(applications),
    db
      .select({ source: dismissals.source, externalId: dismissals.externalId })
      .from(dismissals),
    db
      .select({
        total: sql<number>`count(*)::int`,
        eligible: sql<number>`count(*) filter (where ${jobs.eligibility} = 'eligible')::int`,
        blocked: sql<number>`count(*) filter (where ${jobs.eligibility} = 'blocked')::int`,
        freshWeek: sql<number>`count(*) filter (where ${jobs.postedAt} >= now() - interval '7 days')::int`,
        newToday: sql<number>`count(*) filter (where ${jobs.firstSeenAt} >= now() - interval '1 day')::int`,
        updated: sql<string | null>`max(${jobs.fetchedAt})`,
      })
      .from(jobs),
    queueSnapshot(),
  ]);

  const trackedSet = new Set(
    tracked.map((a) => `${a.source}:${a.externalId}`),
  );
  const dismissedSet = new Set(
    dismissedRows.map((d) => `${d.source}:${d.externalId}`),
  );

  const total = matched?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="rowbar">
        <div>
          <p className="micro">
            {companies.length} companies · {boards.join(" · ")}
          </p>
          <h1>Board</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Ranked by whether a role is worth an application, not by title match.
          </p>
        </div>
        <form action={refreshNow}>
          <SubmitButton className="btn" pendingText="Refreshing…">
            ↻ Refresh now
          </SubmitButton>
        </form>
      </div>

      <div className="stats">
        <span>
          <b>{stats?.total ?? 0}</b>
          <span>roles</span>
        </span>
        <span>
          <b className="good">{stats?.eligible ?? 0}</b>
          <span>you can apply to</span>
        </span>
        <span>
          <b>{stats?.freshWeek ?? 0}</b>
          <span>posted this week</span>
        </span>
        <span>
          <b>{stats?.newToday ?? 0}</b>
          <span>new today</span>
        </span>
        <span title="Roles requiring work authorization you don't have">
          <b className="dim">{stats?.blocked ?? 0}</b>
          <span>blocked</span>
        </span>
        <span className="stats-updated">
          updated {timeAgo(stats?.updated ?? null)}
        </span>
      </div>

      {queue && (
        <RunStatus
          total={companies.length}
          done={queue.done}
          pending={queue.pending}
          running={queue.running}
          unchanged={queue.unchanged}
          dead={queue.dead}
          lastRunAt={queue.lastRunAt ? queue.lastRunAt.toISOString() : null}
          problems={queue.problems}
        />
      )}

      <Filters
        q={sp.q ?? ""}
        source={sp.source ?? ""}
        minScore={String(sp.minScore ?? FILTER_DEFAULTS.minScore)}
        remote={sp.remote ?? ""}
        sort={sort}
        elig={elig}
        maxAge={sp.maxAge ?? ""}
        tracked={sp.tracked ?? ""}
        maxYoe={sp.maxYoe ?? ""}
        dismissed={sp.dismissed ?? ""}
      />

      <p className="count">
        {total === 0
          ? "No matching roles"
          : `${total} matching role${total === 1 ? "" : "s"}`}
        {totalPages > 1 && (
          <span className="dim">
            {" "}
            · page {page} of {totalPages}
          </span>
        )}
        {sp.dismissed === "show" && <span className="dim"> · showing dismissed</span>}
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          {!stats?.total ? (
            "No jobs yet. Hit Refresh now to pull live postings (first run takes a few seconds)."
          ) : page > totalPages ? (
            <>
              Page {page} is past the end of {total} result
              {total === 1 ? "" : "s"}.{" "}
              <a href={pageHref(sp, { page: "" })}>Back to the first page</a>
            </>
          ) : (
            "No roles match these filters. Try widening the age or score."
          )}
        </div>
      ) : (
        <div className="jobs">
          {rows.map((j, i) => {
            const isTracked = trackedSet.has(`${j.source}:${j.externalId}`);
            const isDismissed = dismissedSet.has(`${j.source}:${j.externalId}`);
            const isNew = (daysSince(j.firstSeenAt) ?? 99) < 1;
            return (
              <div
                className={`job ${scoreClass(j.score)}${
                  j.eligibility === "blocked" ? " muted" : ""
                }`}
                key={j.id}
                style={{ "--i": i } as React.CSSProperties}
              >
                <div className="score-wrap" title={`Fit score ${j.score}/100`}>
                  <div
                    className="score"
                    style={{ "--v": j.score } as React.CSSProperties}
                  />
                  <span className="n">{j.score}</span>
                </div>
                <div className="job-main">
                  <a
                    className="job-title"
                    href={j.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {j.title}
                    <span className="ext" aria-hidden="true">
                      ↗
                    </span>
                  </a>
                  <div className="job-meta">
                    <span className="co">{j.company}</span>
                    {j.location ? ` · ${j.location}` : ""}
                    {" · "}
                    <span title={j.postedAt ? new Date(j.postedAt).toDateString() : ""}>
                      {ageLabel(j.postedAt)}
                    </span>
                  </div>
                  <div className="badges">
                    {isNew && <span className="badge new">new</span>}
                    <span
                      className={`badge elig ${j.eligibility}`}
                      title={j.eligibilityReason}
                    >
                      {j.eligibility}
                    </span>
                    {j.remote && <span className="badge remote">remote</span>}
                    {j.compLabel && (
                      <span className="badge pay" title="Pay band stated in the posting">
                        {j.compLabel}
                      </span>
                    )}
                    {j.yoeMin !== null && (
                      <span
                        className="badge yoe"
                        title="Experience the posting asks for. Not scored — plenty of these hire under the stated bar."
                      >
                        {formatYoe(j.yoeMin, j.yoeMax)}
                      </span>
                    )}
                    <span className="badge src">{j.source}</span>
                    {j.reasons
                      .filter((r) => !r.startsWith("blocked:"))
                      .slice(0, 3)
                      .map((r) => (
                        <span className="badge" key={r}>
                          {r}
                        </span>
                      ))}
                  </div>
                </div>
                <div className="job-actions">
                  {isDismissed ? (
                    <form action={restoreJob}>
                      <input type="hidden" name="source" value={j.source} />
                      <input type="hidden" name="externalId" value={j.externalId} />
                      <SubmitButton className="btn ghost small" pendingText="…">
                        ↩ Restore
                      </SubmitButton>
                    </form>
                  ) : isTracked ? (
                    <span className="tracked">✓ Tracked</span>
                  ) : (
                    <form action={trackJob}>
                      <input type="hidden" name="source" value={j.source} />
                      <input type="hidden" name="externalId" value={j.externalId} />
                      <input type="hidden" name="company" value={j.company} />
                      <input type="hidden" name="title" value={j.title} />
                      <input type="hidden" name="url" value={j.url} />
                      <input type="hidden" name="location" value={j.location} />
                      <input type="hidden" name="remote" value={String(j.remote)} />
                      <input type="hidden" name="score" value={j.score} />
                      <input type="hidden" name="eligibility" value={j.eligibility} />
                      <input
                        type="hidden"
                        name="postedAt"
                        value={j.postedAt ? new Date(j.postedAt).toISOString() : ""}
                      />
                      <SubmitButton className="btn ghost small" pendingText="Adding…">
                        + Track
                      </SubmitButton>
                    </form>
                  )}
                  {!isDismissed && !isTracked && (
                    <form action={dismissJob}>
                      <input type="hidden" name="source" value={j.source} />
                      <input type="hidden" name="externalId" value={j.externalId} />
                      <input type="hidden" name="company" value={j.company} />
                      <input type="hidden" name="title" value={j.title} />
                      <SubmitButton
                        className="btn ghost small dismiss"
                        pendingText="…"
                        title="Rule this out — it won't come back on the next refresh"
                      >
                        ✕ Not for me
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="pager" aria-label="Pagination">
          {page > 1 ? (
            <a
              className="btn ghost small"
              href={pageHref(sp, { page: page === 2 ? "" : String(page - 1) })}
            >
              ← Previous
            </a>
          ) : (
            <span className="btn ghost small disabled" aria-disabled="true">
              ← Previous
            </span>
          )}
          <span className="pager-mid">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{" "}
            {total}
          </span>
          {page < totalPages ? (
            <a
              className="btn ghost small"
              href={pageHref(sp, { page: String(page + 1) })}
            >
              Next →
            </a>
          ) : (
            <span className="btn ghost small disabled" aria-disabled="true">
              Next →
            </span>
          )}
        </nav>
      )}
    </>
  );
}

function SetupPanel() {
  return (
    <div className="setup">
      <h1>Almost there</h1>
      <p className="subtitle">Connect a database to start pulling jobs.</p>
      <ol>
        <li>
          Create a free Postgres at <code>neon.tech</code>.
        </li>
        <li>
          Copy <code>.env.example</code> to <code>.env</code> and set{" "}
          <code>DATABASE_URL</code>.
        </li>
        <li>
          Run <code>pnpm db:push</code> to create the tables.
        </li>
        <li>
          Restart <code>pnpm dev</code>, then hit <strong>Refresh now</strong>.
        </li>
      </ol>
    </div>
  );
}
