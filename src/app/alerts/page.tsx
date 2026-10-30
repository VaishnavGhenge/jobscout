import { desc, gte } from "drizzle-orm";
import { db } from "@/db/client";
import { applications, jobAlerts, type JobAlert } from "@/db/schema";
import { scoreClass } from "@/lib/bands";
import {
  WATCH_STALE_MINUTES,
  catchLabel,
  catchMinutes,
  readWatchStatus,
  summarizeCatch,
} from "@/lib/alerts";
import { timeAgo } from "@/lib/time";
import { trackJob } from "../actions";
import { SubmitButton } from "../SubmitButton";

export const dynamic = "force-dynamic";

/** Long enough to cover a weekend away from the laptop. */
const WINDOW_DAYS = 14;

export default async function AlertsPage() {
  const status = readWatchStatus();
  const staleMin = status ? (Date.now() - new Date(status.at).getTime()) / 60000 : null;

  let alerts: JobAlert[] = [];
  let tracked = new Set<string>();
  let missingTable = false;
  let dbError: string | null = null;
  if (db) {
    try {
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
      const [rows, apps] = await Promise.all([
        db.select().from(jobAlerts).where(gte(jobAlerts.detectedAt, since)).orderBy(desc(jobAlerts.detectedAt)),
        db.select({ source: applications.source, externalId: applications.externalId }).from(applications),
      ]);
      alerts = rows;
      tracked = new Set(apps.map((a) => `${a.source}:${a.externalId}`));
    } catch (e) {
      // The table arrives with `pnpm db:push`; until then say so instead of crashing.
      // The watcher status above doesn't need the database, so a Neon hiccup
      // shouldn't take it down with the list.
      const msg = String((e as Error).message);
      if (/job_alerts/.test(msg)) missingTable = true;
      else dbError = msg.slice(0, 160);
    }
  }

  const today = alerts.filter((a) => Date.now() - new Date(a.detectedAt).getTime() < 86_400_000);
  const catchStats = summarizeCatch(alerts);

  return (
    <>
      <div className="rowbar">
        <div>
          <p className="micro">
            watcher · every 10 min · fit {status?.threshold ?? 70}+ · last {WINDOW_DAYS} days
          </p>
          <h1>Alerts</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            New roles the watcher pushed to your phone, newest first. The number
            that matters is how soon after posting each one reached you.
          </p>
        </div>
      </div>

      <div className="stats">
        <span>
          <b>{today.length}</b>
          <span>alerts today</span>
        </span>
        <span>
          <b>{alerts.length}</b>
          <span>in {WINDOW_DAYS} days</span>
        </span>
        <span title="Median time from the role going up to the alert, over alerts with a posting time">
          <b className={catchStats.medianMinutes !== null && catchStats.medianMinutes <= 60 ? "good" : ""}>
            {catchStats.medianMinutes === null ? "–" : `${catchStats.medianMinutes} min`}
          </b>
          <span>median catch</span>
        </span>
        <span>
          <b>{catchStats.withinHour === null ? "–" : `${Math.round(catchStats.withinHour * 100)}%`}</b>
          <span>within an hour</span>
        </span>
        <span className="stats-updated">
          {status ? (
            <>
              watcher ran {timeAgo(status.at)} · {status.polled}/{status.boards} boards ·{" "}
              {status.searches} searches
            </>
          ) : (
            "watcher has not run"
          )}
        </span>
      </div>

      {!status || (staleMin !== null && staleMin > WATCH_STALE_MINUTES) ? (
        <div className="empty">
          {status
            ? `The watcher last ran ${timeAgo(status.at)}. It only runs while the Mac is awake; if it's been awake, check the agent with launchctl print gui/$(id -u)/com.jobscout.watch.`
            : "No watcher status yet. Install it with sh tools/watch/install.sh."}
        </div>
      ) : status.errors.length ? (
        <p className="micro">
          {status.errors.length} board{status.errors.length > 1 ? "s" : ""} failing:{" "}
          {status.errors.join(" · ")}
        </p>
      ) : null}

      {dbError ? (
        <div className="empty">Couldn&apos;t load alerts from the database: {dbError}</div>
      ) : missingTable ? (
        <div className="empty">
          The alerts table doesn&apos;t exist yet. Run <code>pnpm db:push</code>, then
          reload.
        </div>
      ) : !alerts.length ? (
        <div className="empty">
          No alerts in the last {WINDOW_DAYS} days. The watcher alerts on roles
          posted in the last 48 hours that score {status?.threshold ?? 70} or more.
        </div>
      ) : (
        <div className="jobs">
          {alerts.map((a, i) => {
            const isTracked = tracked.has(`${a.source}:${a.externalId}`);
            const caught = catchMinutes(a);
            return (
              <div
                className={`job ${scoreClass(a.score)}`}
                key={a.id}
                style={{ "--i": i } as React.CSSProperties}
              >
                <div className="score-wrap" title={`fit ${a.score}/100 when it was caught`}>
                  <div className="score" style={{ "--v": a.score } as React.CSSProperties} />
                  <span className="n">{a.score}</span>
                </div>
                <div className="job-main">
                  <a className="job-title" href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.title}
                    <span className="ext" aria-hidden="true">
                      ↗
                    </span>
                  </a>
                  <div className="job-meta">
                    <span className="co">{a.company}</span>
                    {a.location ? ` · ${a.location}` : ""}
                    {" · "}
                    <span title={new Date(a.detectedAt).toLocaleString()}>
                      alerted {timeAgo(a.detectedAt)}
                    </span>
                  </div>
                  <div className="badges">
                    <span
                      className={`badge ${caught !== null && caught <= 60 ? "new" : ""}`}
                      title={a.postedAt ? `posted ${new Date(a.postedAt).toLocaleString()}` : ""}
                    >
                      {catchLabel(caught)}
                    </span>
                    {a.applicants && <span className="badge">{a.applicants}</span>}
                    <span className="badge src">{a.source}</span>
                    {a.reasons.slice(0, 3).map((r) => (
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
                      <input type="hidden" name="source" value={a.source} />
                      <input type="hidden" name="externalId" value={a.externalId} />
                      <input type="hidden" name="company" value={a.company} />
                      <input type="hidden" name="title" value={a.title} />
                      <input type="hidden" name="url" value={a.url} />
                      <input type="hidden" name="location" value={a.location} />
                      <input type="hidden" name="remote" value={String(/remote/i.test(a.location))} />
                      <input type="hidden" name="score" value={a.score} />
                      <input type="hidden" name="eligibility" value="eligible" />
                      <input
                        type="hidden"
                        name="postedAt"
                        value={a.postedAt ? new Date(a.postedAt).toISOString() : ""}
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
