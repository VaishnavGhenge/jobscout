import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobAlert } from "@/db/schema";

/**
 * What the watcher wrote after its last tick (tools/watch/watch.ts).
 *
 * Read off the local disk rather than the database on purpose: the watcher
 * only touches Neon when it has something to alert on, and a heartbeat every
 * ten minutes would keep the database awake all day. The app runs on the same
 * machine as the watcher, so the file is right there.
 */
export interface WatchStatus {
  at: string;
  ms: number;
  boards: number;
  polled: number;
  changed: string[];
  searches: number;
  linkedinSeen: number;
  linkedinNew: number;
  alerts: number;
  threshold: number;
  errors: string[];
}

export function readWatchStatus(): WatchStatus | null {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".jobscout", "watch-status.json"), "utf8"),
    ) as WatchStatus;
  } catch {
    return null;
  }
}

/** Ticks are every 10 minutes; two missed in a row means it isn't running. */
export const WATCH_STALE_MINUTES = 25;

/**
 * Minutes between the role going up and it reaching you. Null when the source
 * gave no posting time. LinkedIn's is parsed from "21 minutes ago", so it's
 * good to the minute for fresh roles and coarse for old ones.
 */
export function catchMinutes(a: Pick<JobAlert, "postedAt" | "detectedAt">): number | null {
  if (!a.postedAt) return null;
  const m = (new Date(a.detectedAt).getTime() - new Date(a.postedAt).getTime()) / 60000;
  return Math.max(0, Math.round(m));
}

export function catchLabel(m: number | null): string {
  if (m === null) return "posting time unknown";
  if (m < 90) return `caught ${m} min after posting`;
  if (m < 48 * 60) return `caught ${Math.round(m / 60)} h after posting`;
  return `caught ${Math.round(m / 1440)} d after posting`;
}

export interface CatchSummary {
  timed: number;
  medianMinutes: number | null;
  /** Share caught within an hour of posting, the window that matters. */
  withinHour: number | null;
}

export function summarizeCatch(alerts: Pick<JobAlert, "postedAt" | "detectedAt">[]): CatchSummary {
  const mins = alerts
    .map(catchMinutes)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  if (!mins.length) return { timed: 0, medianMinutes: null, withinHour: null };
  const mid = Math.floor(mins.length / 2);
  return {
    timed: mins.length,
    medianMinutes: mins.length % 2 ? mins[mid] : Math.round((mins[mid - 1] + mins[mid]) / 2),
    withinHour: mins.filter((m) => m <= 60).length / mins.length,
  };
}

/** The workflow that runs the watcher once it's in the cloud (.github/workflows/watch.yml). */
const WATCH_WORKFLOW_RUNS =
  "https://api.github.com/repos/VaishnavGhenge/jobscout/actions/workflows/watch.yml/runs?per_page=1";

export interface RemoteWatch {
  at: string;
  /** "success", "failure", or null while a run is in progress. */
  conclusion: string | null;
  url: string;
}

/**
 * The latest GitHub Actions run of the watcher. The cloud runner can't write
 * the local status file, so this is how the page knows it's alive. Public repo,
 * so no token; cached for a minute to stay far under the 60/hour anonymous limit.
 */
export async function readRemoteWatch(): Promise<RemoteWatch | null> {
  try {
    const r = await fetch(WATCH_WORKFLOW_RUNS, {
      headers: { accept: "application/vnd.github+json" },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const run = (await r.json()).workflow_runs?.[0];
    return run ? { at: run.updated_at, conclusion: run.conclusion, url: run.html_url } : null;
  } catch {
    return null;
  }
}
