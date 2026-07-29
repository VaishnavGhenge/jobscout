import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { applications, type Application, type ApplicationStatus } from "@/db/schema";
import {
  buildFunnel,
  hasReplied,
  isGhosted,
  pct,
  GHOST_AFTER_DAYS,
} from "@/lib/insights";
import { isManualSource } from "@/lib/sources";
import { daysSince } from "@/lib/time";
import { markReplied, removeApplication } from "../actions";
import { ApplicationDialog } from "./ApplicationDialog";
import { StatusSelect } from "./StatusSelect";
import { SubmitButton } from "../SubmitButton";

export const dynamic = "force-dynamic";

const COLUMNS: { key: ApplicationStatus; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "applied", label: "Applied" },
  { key: "interviewing", label: "Interviewing" },
  { key: "offer", label: "Offer" },
  { key: "rejected", label: "Rejected" },
];

export default async function TrackerPage() {
  if (!db) {
    return (
      <div className="empty">
        Configure <code>DATABASE_URL</code> to use the tracker.
      </div>
    );
  }

  const apps: Application[] = await db
    .select()
    .from(applications)
    .orderBy(desc(applications.updatedAt));

  const funnel = buildFunnel(apps);
  const byStatus = (s: ApplicationStatus) => apps.filter((a) => a.status === s);

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
          <span>
            <b className="good">{funnel.replied}</b>
            <span>replied</span>
          </span>
          <span>
            <b>{pct(funnel.replyRate)}</b>
            <span>reply rate</span>
          </span>
          <span>
            <b className="warn">{funnel.waiting}</b>
            <span>waiting</span>
          </span>
          <span title={`No reply after ${GHOST_AFTER_DAYS} days`}>
            <b className="bad">{funnel.ghosted}</b>
            <span>ghosted</span>
          </span>
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
                          <span className="badge good-badge">replied</span>
                        ) : ghosted ? (
                          <span className="badge bad-badge">
                            no reply · {sinceApplied}d
                          </span>
                        ) : sinceApplied !== null ? (
                          <span className="badge">applied {sinceApplied}d ago</span>
                        ) : null}
                      </div>

                      {a.notes && <p className="card-note">{a.notes}</p>}

                      <StatusSelect id={a.id} status={a.status} />

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
                            <SubmitButton className="linkbtn ok" pendingText="…">
                              Got reply
                            </SubmitButton>
                          </form>
                        )}
                        <form action={removeApplication} style={{ marginLeft: "auto" }}>
                          <input type="hidden" name="id" value={a.id} />
                          <SubmitButton className="linkbtn" pendingText="Removing…">
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
  );
}
