import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, applications } from "@/db/schema";
import { companies } from "@/lib/companies";
import { ageLabel, daysSince, timeAgo } from "@/lib/time";
import { formatYoe } from "@/lib/yoe";
import { queueSnapshot } from "@/lib/queue";
import { refreshNow, trackJob } from "./actions";
import { SubmitButton } from "./SubmitButton";
import { Filters, FILTER_DEFAULTS } from "./Filters";
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
};

function scoreClass(s: number) {
  return s >= 70 ? "high" : s >= 45 ? "mid" : "low";
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

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

  const order =
    sort === "recent"
      ? [desc(jobs.postedAt), desc(jobs.score)]
      : sort === "new"
        ? [desc(jobs.firstSeenAt), desc(jobs.score)]
        : [desc(jobs.score), desc(jobs.postedAt)];

  const [rows, tracked, [stats], queue] = await Promise.all([
    db.select().from(jobs).where(and(...filters)).orderBy(...order).limit(250),
    db
      .select({ source: applications.source, externalId: applications.externalId })
      .from(applications),
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
      />

      <p className="count">
        Showing {rows.length}
        {rows.length === 250 ? "+ (capped)" : ""} matching role
        {rows.length === 1 ? "" : "s"}
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          {stats?.total
            ? "No roles match these filters. Try widening the age or score."
            : "No jobs yet. Hit Refresh now to pull live postings (first run takes a few seconds)."}
        </div>
      ) : (
        <div className="jobs">
          {rows.map((j, i) => {
            const isTracked = trackedSet.has(`${j.source}:${j.externalId}`);
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
                  {isTracked ? (
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
                </div>
              </div>
            );
          })}
        </div>
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
