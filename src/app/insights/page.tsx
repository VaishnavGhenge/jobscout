import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db/client";
import { applications, type Application } from "@/db/schema";
import {
  buildFunnel,
  freshnessBucket,
  pct,
  sliceBy,
  GHOST_AFTER_DAYS,
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

  const apps: Application[] = await db.select().from(applications);
  const funnel = buildFunnel(apps);

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
    </>
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
