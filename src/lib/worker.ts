import { companies } from "./companies";
import { HttpError } from "./connectors/types";
import {
  claimTasks,
  claimableCount,
  completeTask,
  failTask,
  releaseTask,
  MAX_ATTEMPTS,
} from "./queue";
import { refreshCompany } from "./refresh";

/**
 * The worker: claims refresh tasks and runs them until it runs out of work or
 * out of time. Designed to be invoked repeatedly (by cron, by itself, or by the
 * "Refresh now" button) rather than to run forever — several invocations can
 * safely overlap, because claiming is atomic.
 */

/**
 * Stop *starting* boards this far into the invocation. The routes cap at 60s and
 * a single board can take a while — Stripe's board needs ~26s even to answer 304
 * — so the last task must be able to start here and still finish inside the cap:
 * 25s cutoff + 30s fetch timeout < 60s.
 */
const START_CUTOFF_MS = 25_000;

/** Tasks claimed per round trip. Small: leases shouldn't outlive the work. */
const SLICE = 3;

/** Pause between outbound board fetches, jittered. Politeness, not throttling. */
const GAP_MS = 300;
const GAP_JITTER_MS = 500;

export interface DrainSummary {
  claimed: number;
  ok: number;
  /** Boards that answered 304 — the cheap, common case on a warm queue. */
  unchanged: number;
  failed: number;
  /** Work still claimable after this invocation gave up its slot. */
  remaining: number;
  durationMs: number;
  details: {
    company: string;
    outcome: "ok" | "unchanged" | "failed";
    kept?: number;
    fresh?: number;
    ms?: number;
    error?: string;
  }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function drain(budgetMs = START_CUTOFF_MS): Promise<DrainSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const summary: DrainSummary = {
    claimed: 0,
    ok: 0,
    unchanged: 0,
    failed: 0,
    remaining: 0,
    durationMs: 0,
    details: [],
  };

  while (Date.now() < deadline) {
    const tasks = await claimTasks(SLICE);
    if (tasks.length === 0) break;
    summary.claimed += tasks.length;

    for (const task of tasks) {
      // Out of time: hand back everything we claimed but haven't started, so it
      // is immediately claimable instead of sitting out a 2-minute lease.
      if (Date.now() >= deadline) {
        await releaseTask(task.id);
        summary.claimed--;
        continue;
      }

      const company = companies.find((c) => c.name === task.company);
      if (!company) {
        // Removed from companies.ts mid-run. Burn its attempts so it dies out
        // rather than being reclaimed forever.
        await failTask(task, "company no longer configured", null);
        summary.failed++;
        summary.details.push({
          company: task.company,
          outcome: "failed",
          error: "company no longer configured",
        });
        continue;
      }

      try {
        const result = await refreshCompany(company, {
          etag: task.etag,
          lastModified: task.lastModified,
        });
        await completeTask(task.id, {
          kept: result.kept,
          eligible: result.eligible,
          fresh: result.fresh,
          unchanged: result.unchanged,
          durationMs: result.durationMs,
          etag: result.etag,
          lastModified: result.lastModified,
        });
        if (result.unchanged) summary.unchanged++;
        else summary.ok++;
        summary.details.push({
          company: company.name,
          outcome: result.unchanged ? "unchanged" : "ok",
          kept: result.kept,
          fresh: result.fresh,
          ms: result.durationMs,
        });
      } catch (err) {
        // A host that says "come back in N seconds" always wins over our curve.
        const retryAfter =
          err instanceof HttpError && err.shouldBackOff
            ? (err.retryAfterSeconds ?? null)
            : null;
        const message = err instanceof Error ? err.message : String(err);
        await failTask(task, message, retryAfter);
        summary.failed++;
        summary.details.push({
          company: company.name,
          outcome: "failed",
          error:
            task.attempts >= MAX_ATTEMPTS ? `${message} (giving up)` : message,
        });
      }

      if (Date.now() < deadline) {
        await sleep(GAP_MS + Math.random() * GAP_JITTER_MS);
      }
    }
  }

  summary.remaining = await claimableCount();
  summary.durationMs = Date.now() - startedAt;
  return summary;
}
