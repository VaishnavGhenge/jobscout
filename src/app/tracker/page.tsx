import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { applications, type Application, type ApplicationStatus } from "@/db/schema";
import {
  buildFunnel,
  daysToReply,
  hasReplied,
  isGhosted,
  isWaiting,
  pct,
  GHOST_AFTER_DAYS,
} from "@/lib/insights";
import { isManualSource } from "@/lib/sources";
import { daysSince } from "@/lib/time";
import { markReplied, removeApplication } from "../actions";
import { ApplicationDialog } from "./ApplicationDialog";
import { StatusSelect } from "./StatusSelect";
import { SubmitButton } from "../SubmitButton";
import { TRACKER_DEFAULTS } from "@/lib/filter-defaults";
import { TrackerFilters } from "./TrackerFilters";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Tracker" };

const COLUMNS: { key: ApplicationStatus; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "applied", label: "Applied" },
  { key: "interviewing", label: "Interviewing" },
  { key: "offer", label: "Offer" },
  { key: "rejected", label: "Rejected" },
];

type Search = {
  q?: string;
  /** "waiting" | "ghosted" | "replied"; "" for any. */
  reply?: string;
  /** Applied via. */
  src?: string;
  sort?: string;
};

/** Everything a search should look inside — notes included, that's where the
 *  recruiter's name usually is. */
function haystack(a: Application): string {
  return `${a.company} ${a.title} ${a.location} ${a.notes} ${a.source}`.toLowerCase();
}

/** Sort within a column. Null dates sink: nothing to wait on, nothing to rank. */
function comparator(sort: string) {
  const at = (d: Date | string | null) => (d ? new Date(d).getTime() : null);
  if (sort === "waiting") {
    return (a: Application, b: Application) => {
      const x = at(a.appliedAt);
      const y = at(b.appliedAt);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return x - y; // oldest application first — the one you've waited longest on
    };
  }
  if (sort === "applied") {
    return (a: Application, b: Application) => {
      const x = at(a.appliedAt);
      const y = at(b.appliedAt);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return y - x;
    };
  }
  return null; // "updated" — the order the query already returned
}

export default async function TrackerPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  if (!db) {
    return (
      <div className="empty">
        Configure <code>DATABASE_URL</code> to use the tracker.
      </div>
    );
  }

  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase();
  const reply = sp.reply ?? "";
  const src = sp.src ?? "";
  const sort = sp.sort ?? TRACKER_DEFAULTS.sort;

  const apps: Application[] = await db
    .select()
    .from(applications)
    .orderBy(desc(applications.updatedAt));

  // The funnel stays on the whole pipeline. A reply rate that moved every time
  // you searched for a company would be a different number with the same label.
  const funnel = buildFunnel(apps);

  const sources = [...new Set(apps.map((a) => a.source))].sort();

  const shown = apps.filter((a) => {
    if (q && !haystack(a).includes(q)) return false;
    if (src && a.source !== src) return false;
    if (reply === "waiting" && !isWaiting(a)) return false;
    if (reply === "ghosted" && !isGhosted(a)) return false;
    if (reply === "replied" && !hasReplied(a)) return false;
    return true;
  });

  const cmp = comparator(sort);
  const ordered = cmp ? [...shown].sort(cmp) : shown;
  const filtering = Boolean(q || reply || src);
  const byStatus = (s: ApplicationStatus) =>
    ordered.filter((a) => a.status === s);

  /** A funnel number that doubles as a filter — click 14 ghosted, see them.
   *  Clicking the one that's already on turns it off; the rest of the bar stays. */
  function statHref(v: string): string {
    const params = new URLSearchParams();
    for (const [k, val] of Object.entries({ ...sp, reply: reply === v ? "" : v })) {
      if (val) params.set(k, String(val));
    }
    const qs = params.toString();
    return qs ? `/tracker?${qs}` : "/tracker";
  }

  return (
    <>
      <div className="rowbar">
        <div>
          <p className="micro">
            {apps.length} application{apps.length === 1 ? "" : "s"} · silent{" "}
            {GHOST_AFTER_DAYS}d = ghosted
          </p>
          <h1>Tracker</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Your pipeline, and how long each side has been waiting on the other.
          </p>
        </div>
        <div className="rowbar-actions">
          <ApplicationDialog label="+ Add manually" className="btn" />
          <Link className="btn ghost" href="/insights">
            Insights →
          </Link>
        </div>
      </div>

      {funnel.applied > 0 && (
        <div className="stats">
          <span>
            <b>{funnel.applied}</b>
            <span>applied</span>
          </span>
          <Link
            href={statHref("replied")}
            data-on={reply === "replied" ? "1" : undefined}
            title="Show the ones that answered"
          >
            <b className="good">{funnel.replied}</b>
            <span>replied</span>
          </Link>
          <span>
            <b>{pct(funnel.replyRate)}</b>
            <span>reply rate</span>
          </span>
          <Link
            href={statHref("waiting")}
            data-on={reply === "waiting" ? "1" : undefined}
            title="Show the ones still inside the normal wait"
          >
            <b className="warn">{funnel.waiting}</b>
            <span>waiting</span>
          </Link>
          <Link
            href={statHref("ghosted")}
            data-on={reply === "ghosted" ? "1" : undefined}
            title={`No reply after ${GHOST_AFTER_DAYS} days`}
          >
            <b className="bad">{funnel.ghosted}</b>
            <span>ghosted</span>
          </Link>
        </div>
      )}

      {apps.length === 0 ? (
        <div className="empty">
          <p>
            Nothing tracked yet. Hit <strong>+ Track</strong> on the{" "}
            <strong>Board</strong>, or add one you applied to elsewhere.
          </p>
          <ApplicationDialog label="+ Add manually" />
        </div>
      ) : (
        <>
          <TrackerFilters
            q={sp.q ?? ""}
            reply={reply}
            src={src}
            sort={sort}
            sources={sources}
          />

          <p className="count">
            {filtering
              ? `${ordered.length} of ${apps.length} shown`
              : `${apps.length} application${apps.length === 1 ? "" : "s"}`}
            {sort === "waiting" && (
              <span className="dim"> · longest waiting first</span>
            )}
          </p>

          {ordered.length === 0 ? (
            <div className="empty">
              <p>
                No application matches that. The filters only look at what you&apos;ve
                already tracked.
              </p>
              <Link className="btn ghost" href="/tracker">
                Clear filters
              </Link>
            </div>
          ) : (
            <div className="board">
              {COLUMNS.map((col) => {
                const items = byStatus(col.key);
                return (
                  <div className="col" data-s={col.key} key={col.key}>
                    <h3>
                      {col.label} <span className="n">{items.length}</span>
                    </h3>
                    {items.length === 0 && <p className="col-empty">—</p>}
                    {items.map((a) => {
                      const sinceApplied = daysSince(a.appliedAt);
                      const ghosted = isGhosted(a);
                      const replied = hasReplied(a);
                      const gap = daysToReply(a);
                      return (
                        <div className={`card${ghosted ? " ghosted" : ""}`} key={a.id}>
                          {a.url ? (
                            <a
                              className="co"
                              href={a.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {a.company}
                            </a>
                          ) : (
                            <span className="co">{a.company}</span>
                          )}
                          <div className="ti">{a.title}</div>

                          <div className="card-tags">
                            {isManualSource(a.source) && (
                              <span className="badge">{a.source}</span>
                            )}
                            {a.eligibility !== "eligible" && (
                              <span className={`badge elig ${a.eligibility}`}>
                                {a.eligibility}
                              </span>
                            )}
                            {replied ? (
                              <span
                                className="badge good-badge"
                                title="Edit the application to correct the reply date"
                              >
                                {gap === null
                                  ? "replied"
                                  : gap === 0
                                    ? "replied same day"
                                    : `replied in ${gap}d`}
                              </span>
                            ) : ghosted ? (
                              <span className="badge bad-badge">
                                no reply · {sinceApplied}d
                              </span>
                            ) : sinceApplied !== null ? (
                              <span className="badge">applied {sinceApplied}d ago</span>
                            ) : null}
                          </div>

                          {a.notes && <p className="card-note">{a.notes}</p>}

                          <StatusSelect
                            id={a.id}
                            status={a.status}
                            label={`Status for ${a.company} — ${a.title}`}
                          />

                          <div className="card-row">
                            {a.url && (
                              <a href={a.url} target="_blank" rel="noopener noreferrer">
                                Open ↗
                              </a>
                            )}
                            <ApplicationDialog
                              app={a}
                              label="Edit"
                              className="linkbtn edit"
                            />
                            {a.appliedAt && !replied && (
                              <form action={markReplied}>
                                <input type="hidden" name="id" value={a.id} />
                                <SubmitButton
                                  className="linkbtn ok"
                                  pendingText="…"
                                  title="Stamps a reply today. Heard back earlier? Use Edit to set the real date."
                                >
                                  Got reply
                                </SubmitButton>
                              </form>
                            )}
                            <form
                              action={removeApplication}
                              style={{ marginLeft: "auto" }}
                            >
                              <input type="hidden" name="id" value={a.id} />
                              <SubmitButton
                                className="linkbtn"
                                pendingText="Removing…"
                                confirm={`Remove ${a.company} — ${a.title} from the tracker? This can't be undone.`}
                              >
                                Remove
                              </SubmitButton>
                            </form>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
