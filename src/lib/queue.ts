import { and, eq, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { requireDb } from "@/db/client";
import { refreshTasks, type RefreshTask } from "@/db/schema";
import { companies } from "./companies";

/**
 * A Postgres-backed work queue for board refreshes. One durable row per company.
 *
 * Why not just `Promise.all(companies.map(refresh))`? Because that puts 31
 * outbound fetches and the whole run inside a single 60s serverless invocation:
 * one slow board takes down the run, nothing is retried, and adding sources with
 * per-posting detail calls is impossible. Here each company is an independent
 * unit of work that can be retried, backed off, and spread across invocations.
 *
 * Claiming is a *lease*, not a delete: a worker that dies mid-fetch (timeout,
 * redeploy) leaves its row in `running` with an expired `leaseUntil`, and the
 * next worker picks it up. Nothing is lost, nothing needs a janitor process.
 *
 * The whole thing runs over Neon's HTTP driver, which has no multi-statement
 * transactions — so the claim has to be atomic *within one statement*. That's
 * what the `FOR UPDATE SKIP LOCKED` sub-select below buys: two workers running
 * concurrently can never claim the same row.
 */

/** Attempts before a company is parked until the next full enqueue. */
export const MAX_ATTEMPTS = 4;

/** How long a claim is held before another worker may steal it. */
const LEASE_SECONDS = 120;

/** Backoff schedule: 20s, 40s, 80s … capped, then jittered. */
const BASE_BACKOFF_SECONDS = 20;
const MAX_BACKOFF_SECONDS = 30 * 60;

export interface TaskOutcome {
  kept: number;
  eligible: number;
  fresh: number;
  /** Board answered 304 — nothing was re-fetched or rewritten. */
  unchanged: boolean;
  durationMs: number;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Queue every company for refresh. Idempotent: re-running resets state and
 * attempts but deliberately *keeps* each board's ETag, so a run that finds
 * nothing changed still costs only a 304 per board.
 */
export async function enqueueAll(): Promise<number> {
  const db = requireDb();
  const names = companies.map((c) => c.name);

  await db
    .insert(refreshTasks)
    .values(names.map((company) => ({ company })))
    .onConflictDoUpdate({
      target: refreshTasks.company,
      set: {
        state: "queued",
        attempts: 0,
        runAfter: sql`now()`,
        leaseUntil: null,
        lastError: null,
        updatedAt: sql`now()`,
      },
    });

  // Drop rows for companies removed from companies.ts, so the status board
  // doesn't accumulate ghosts.
  await db.delete(refreshTasks).where(notInArray(refreshTasks.company, names));

  return names.length;
}

/** Queue a single company (manual re-run of one board). */
export async function enqueueCompany(company: string): Promise<void> {
  const db = requireDb();
  await db
    .insert(refreshTasks)
    .values({ company })
    .onConflictDoUpdate({
      target: refreshTasks.company,
      set: {
        state: "queued",
        attempts: 0,
        runAfter: sql`now()`,
        leaseUntil: null,
        lastError: null,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Atomically take up to `limit` tasks. Returns the claimed rows, already
 * marked `running` with a lease and an incremented attempt count.
 */
export async function claimTasks(limit: number): Promise<RefreshTask[]> {
  const db = requireDb();

  const claimable = db
    .select({ id: refreshTasks.id })
    .from(refreshTasks)
    .where(
      or(
        and(
          inArray(refreshTasks.state, ["queued", "failed"]),
          lte(refreshTasks.runAfter, sql`now()`),
        ),
        // Lease expired: the worker that held this died. Take it back.
        and(
          eq(refreshTasks.state, "running"),
          lt(refreshTasks.leaseUntil, sql`now()`),
        ),
      ),
    )
    .orderBy(refreshTasks.runAfter)
    .limit(limit)
    .for("update", { skipLocked: true });

  return db
    .update(refreshTasks)
    .set({
      state: "running",
      attempts: sql`${refreshTasks.attempts} + 1`,
      leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
      updatedAt: sql`now()`,
    })
    .where(inArray(refreshTasks.id, claimable))
    .returning();
}

export async function completeTask(
  id: number,
  outcome: TaskOutcome,
): Promise<void> {
  const db = requireDb();
  await db
    .update(refreshTasks)
    .set({
      state: "done",
      leaseUntil: null,
      lastError: null,
      lastRunAt: sql`now()`,
      lastDurationMs: outcome.durationMs,
      lastUnchanged: outcome.unchanged,
      lastResult: {
        kept: outcome.kept,
        eligible: outcome.eligible,
        fresh: outcome.fresh,
      },
      // Only overwrite validators when the host actually sent new ones.
      ...(outcome.etag ? { etag: outcome.etag } : {}),
      ...(outcome.lastModified ? { lastModified: outcome.lastModified } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(refreshTasks.id, id));
}

/**
 * Hand a claimed task back unprocessed — the worker ran out of time before
 * starting it. Gives back the attempt too: being time-boxed isn't a failure, and
 * burning attempts on it would eventually mark healthy boards dead.
 */
export async function releaseTask(id: number): Promise<void> {
  const db = requireDb();
  await db
    .update(refreshTasks)
    .set({
      state: "queued",
      leaseUntil: null,
      runAfter: sql`now()`,
      attempts: sql`greatest(${refreshTasks.attempts} - 1, 0)`,
      updatedAt: sql`now()`,
    })
    .where(eq(refreshTasks.id, id));
}

/**
 * Record a failure and schedule the retry. `retryAfterSeconds` comes from the
 * host's own `Retry-After` header when it sent one — if a board tells us when
 * to come back, that beats any backoff curve we invent.
 */
export async function failTask(
  task: RefreshTask,
  message: string,
  retryAfterSeconds: number | null,
): Promise<void> {
  const db = requireDb();
  const dead = task.attempts >= MAX_ATTEMPTS;
  const delay = retryAfterSeconds ?? backoffSeconds(task.attempts);

  await db
    .update(refreshTasks)
    .set({
      state: dead ? "dead" : "failed",
      leaseUntil: null,
      runAfter: sql`now() + make_interval(secs => ${delay})`,
      lastError: message.slice(0, 500),
      lastRunAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(refreshTasks.id, task.id));
}

/** Exponential backoff with jitter, so retries don't re-synchronise into a burst. */
function backoffSeconds(attempts: number): number {
  const exponential = BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_SECONDS);
  return Math.round(capped * (1 + Math.random() * 0.3));
}

/**
 * Tasks a worker could pick up *right now*. Distinct from `pendingCount`, which
 * includes tasks sitting out a backoff — chaining on those would spin a worker
 * in a tight loop claiming nothing.
 */
export async function claimableCount(): Promise<number> {
  const db = requireDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(refreshTasks)
    .where(
      or(
        and(
          inArray(refreshTasks.state, ["queued", "failed"]),
          lte(refreshTasks.runAfter, sql`now()`),
        ),
        and(
          eq(refreshTasks.state, "running"),
          lt(refreshTasks.leaseUntil, sql`now()`),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** Tasks waiting or in flight. Drives both worker chaining and the UI. */
export async function pendingCount(): Promise<number> {
  const db = requireDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(refreshTasks)
    .where(inArray(refreshTasks.state, ["queued", "running", "failed"]));
  return row?.n ?? 0;
}

export interface QueueSnapshot {
  queued: number;
  running: number;
  done: number;
  failed: number;
  dead: number;
  pending: number;
  unchanged: number;
  lastRunAt: Date | null;
  /** Boards that ended the run broken, newest first. */
  problems: { company: string; state: string; error: string | null }[];
}

/** Everything the board's status strip needs, in one round trip. */
export async function queueSnapshot(): Promise<QueueSnapshot | null> {
  const db = requireDb();
  const rows = await db.select().from(refreshTasks);
  if (rows.length === 0) return null;

  const count = (s: string) => rows.filter((r) => r.state === s).length;
  const lastRuns = rows
    .map((r) => r.lastRunAt)
    .filter((d): d is Date => d !== null);

  return {
    queued: count("queued"),
    running: count("running"),
    done: count("done"),
    failed: count("failed"),
    dead: count("dead"),
    pending: rows.filter((r) =>
      ["queued", "running", "failed"].includes(r.state),
    ).length,
    unchanged: rows.filter((r) => r.state === "done" && r.lastUnchanged).length,
    lastRunAt: lastRuns.length
      ? new Date(Math.max(...lastRuns.map((d) => d.getTime())))
      : null,
    problems: rows
      .filter((r) => r.state === "dead" || r.state === "failed")
      .map((r) => ({
        company: r.company,
        state: r.state,
        error: r.lastError,
      })),
  };
}
