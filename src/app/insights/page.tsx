import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db/client";
import { applications, dismissals, type Application } from "@/db/schema";
import {
  buildFunnel,
  freshnessBucket,
  pct,
  sliceBy,
  summarizeDismissals,
  DISMISS_LEVER,
  GHOST_AFTER_DAYS,
  type DismissalSlice,
  type Slice,
} from "@/lib/insights";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Insights" };

/** Below this many applications, a reply rate is noise, not a signal. */
const MIN_SAMPLE = 5;

/** Colour the bar by how good the rate is, so the eye can skim the tables. */
function barTone(rate: number | null) {
  if (rate === null) return "";
  return rate >= 0.25 ? "good" : rate >= 0.1 ? "warn" : "";
}

export default async function InsightsPage() {
  if (!db) {
    return (
      <div className="empty">
        Configure <code>DATABASE_URL</code> to see insights.
      </div>
    );
  }

  const [apps, dismissed]: [Application[], { reason: string; score: number }[]] =
    await Promise.all([
      db.select().from(applications),
      db
        .select({ reason: dismissals.reason, score: dismissals.score })
        .from(dismissals),
    ]);
  const funnel = buildFunnel(apps);
  const overruled = summarizeDismissals(dismissed);

  if (funnel.applied === 0) {
    return (
      <>
        <h1>Insights</h1>
        <p className="subtitle">
          Where your applications actually go.
        </p>
        <div className="empty">
          Nothing to measure yet. Move a tracked role to <strong>Applied</strong>{" "}
          on the <Link href="/tracker">Tracker</Link> — from then on this page
          shows which kinds of applications get replies and which don&apos;t.
        </div>
        <Overruled rows={overruled} />
      </>
    );
  }

  const slices: { title: string; hint: string; rows: Slice[] }[] = [
    {
      title: "By eligibility",
      hint: "If blocked roles reply at ~0%, the region filter is earning its keep.",
      rows: sliceBy(apps, (a) => a.eligibility),
    },
    {
      title: "By posting age when you applied",
      hint: "Applying to fresh reqs should beat applying to months-old ones.",
      rows: sliceBy(apps, freshnessBucket),
    },
    {
      title: "By work location",
      hint: "Remote roles draw far more applicants than on-site ones.",
      rows: sliceBy(apps, (a) => (a.remote ? "remote" : "on-site / hybrid")),
    },
    {
      title: "By company",
      hint: "Where your applications are actually landing.",
      rows: sliceBy(apps, (a) => a.company).slice(0, 12),
    },
    {
      title: "By job board",
      hint: "Mostly a proxy for company type, but occasionally revealing.",
      rows: sliceBy(apps, (a) => a.source),
    },
  ];

  return (
    <>
      <div className="rowbar">
        <div>
          <p className="micro">{funnel.applied} applications measured</p>
          <h1>Insights</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Which kinds of applications get answered — and which quietly
            don&apos;t.
          </p>
        </div>
        <Link className="btn ghost" href="/tracker">
          ← Tracker
        </Link>
      </div>

      {/* The three counts you can act on link into the tracker already filtered:
          a number you can't do anything with is just decoration. */}
      <div className="funnel">
        <Stat n={funnel.applied} label="applied" />
        <Stat
          n={funnel.replied}
          label="got a reply"
          tone="good"
          href="/tracker?reply=replied"
        />
        <Stat n={funnel.interviewing} label="interviewing" tone="good" />
        <Stat n={funnel.offers} label="offers" tone="good" />
        <Stat
          n={funnel.waiting}
          label="still waiting"
          tone="warn"
          href="/tracker?reply=waiting"
        />
        <Stat
          n={funnel.ghosted}
          label={`silent ${GHOST_AFTER_DAYS}d+`}
          tone="bad"
          href="/tracker?reply=ghosted"
        />
      </div>

      <div className="headline">
        <div>
          <span className="big">{pct(funnel.replyRate)}</span>
          <span className="lbl">of applications get any reply</span>
        </div>
        {funnel.medianDaysToReply !== null && (
          <div>
            <span className="big">{funnel.medianDaysToReply}d</span>
            <span className="lbl">median time to first reply</span>
          </div>
        )}
      </div>

      {funnel.applied < 10 && (
        <p className="note">
          Only {funnel.applied} application{funnel.applied === 1 ? "" : "s"} so
          far — treat the breakdowns below as directional until you have a few
          dozen. Rows under {MIN_SAMPLE} applications are greyed out.
        </p>
      )}

      {slices.map((s) => (
        <section className="slice" key={s.title}>
          <h2>{s.title}</h2>
          <p className="hint">{s.hint}</p>
          <table className="grid">
            <thead>
              <tr>
                <th>Group</th>
                <th className="num">Applied</th>
                <th className="num">Replied</th>
                <th className="num">Rate</th>
                <th className="bar-col" />
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.label} className={r.applied < MIN_SAMPLE ? "thin" : ""}>
                  <td>{r.label}</td>
                  <td className="num">{r.applied}</td>
                  <td className="num">{r.replied}</td>
                  <td className="num">{pct(r.rate)}</td>
                  <td className="bar-col">
                    <span className="bar-track">
                      <span
                        className={`bar ${barTone(r.rate)}`}
                        style={{ width: `${Math.round((r.rate ?? 0) * 100)}%` }}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <Overruled rows={overruled} />
    </>
  );
}

/**
 * Roles the board ranked well and you rejected anyway.
 *
 * Reply rates need dozens of applications before they mean anything. This needs
 * one dismissal, which is why it's the fastest feedback in the app: a high
 * `topScore` next to "wrong stack" is a specific instruction to go and edit
 * `profile.offStackTech`, available the same afternoon.
 */
function Overruled({ rows }: { rows: DismissalSlice[] }) {
  return (
    <section className="slice">
      <h2>Where the ranking disagreed with you</h2>
      <p className="hint">
        Grouped by why you ruled a role out. The score is what the board gave it
        at the time, so a high one means the weights need editing, not the filter.
      </p>
      {rows.length === 0 ? (
        <div className="empty">
          Nothing dismissed yet. Use <strong>Not for me</strong> on the board and
          pick a reason: it&apos;s the only signal here that works from a sample
          of one.
        </div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Reason</th>
              <th className="num">Dismissed</th>
              <th className="num">Avg score</th>
              <th className="num">Top score</th>
              <th>Lever</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.reason}>
                <td>{r.reason}</td>
                <td className="num">{r.count}</td>
                <td className="num">{r.avgScore}</td>
                <td className="num">
                  <b className={r.topScore >= 78 ? "bad" : ""}>{r.topScore}</b>
                </td>
                <td>
                  <code>{DISMISS_LEVER[r.reason] ?? "unclassified"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Stat({
  n,
  label,
  tone,
  href,
}: {
  n: number;
  label: string;
  tone?: "good" | "warn" | "bad";
  /** Where this number lives in the tracker, when there's somewhere to go. */
  href?: string;
}) {
  const body = (
    <>
      <b className={tone ?? ""}>{n}</b>
      <span>{label}</span>
    </>
  );
  if (!href || n === 0) return <div className="fstat">{body}</div>;
  return (
    <Link className="fstat linked" href={href}>
      {body}
    </Link>
  );
}
