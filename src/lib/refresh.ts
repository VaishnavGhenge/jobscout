import { eq } from "drizzle-orm";
import { requireDb } from "@/db/client";
import { jobs, type NewJob } from "@/db/schema";
import { companies, type Company } from "./companies";
import { connectors } from "./connectors";
import type { Conditional } from "./connectors/types";
import { isEngineeringRole, scoreJob } from "./scoring";

export interface CompanyResult {
  company: string;
  fetched: number;
  kept: number;
  eligible: number;
  blocked: number;
  /** Postings we hadn't seen on any previous refresh. */
  fresh: number;
  /** Board answered 304: nothing re-fetched, existing rows left alone. */
  unchanged: boolean;
  durationMs: number;
  etag: string | null;
  lastModified: string | null;
  error?: string;
}

const CHUNK = 100;

/**
 * How many boards to fetch at once in the inline path. 31 simultaneous requests
 * from one serverless IP is what trips rate limiters; a handful at a time is
 * indistinguishable from normal traffic and costs only a few seconds more.
 */
const FETCH_CONCURRENCY = 5;

/**
 * Fetch one company's board, filter to eng roles, score, and replace its rows.
 *
 * Throws on fetch failure — the caller decides whether that's a retry (queue) or
 * a per-company error line (inline refresh). Pass `cond` to send the ETag from
 * the last successful run: an unchanged board then costs a 304 and no writes.
 */
export async function refreshCompany(
  company: Company,
  cond?: Conditional,
): Promise<CompanyResult> {
  const db = requireDb();
  const startedAt = Date.now();
  const result = await connectors[company.ats].fetch(company, cond);

  const base = {
    company: company.name,
    etag: result.etag,
    lastModified: result.lastModified,
  };

  if (result.notModified) {
    return {
      ...base,
      fetched: 0,
      kept: 0,
      eligible: 0,
      blocked: 0,
      fresh: 0,
      unchanged: true,
      durationMs: Date.now() - startedAt,
    };
  }

  // Rows are deleted and re-inserted below, which would reset any timestamp
  // stored on them. Carry first-seen forward so "new since yesterday" means
  // something — it's the cohort most likely to get a reply.
  const existing = await db
    .select({ externalId: jobs.externalId, firstSeenAt: jobs.firstSeenAt })
    .from(jobs)
    .where(eq(jobs.company, company.name));
  const firstSeen = new Map(existing.map((r) => [r.externalId, r.firstSeenAt]));

  const now = new Date();
  const seen = new Set<string>();
  const rows: NewJob[] = [];
  for (const p of result.postings) {
    if (seen.has(p.externalId)) continue;
    seen.add(p.externalId);
    if (!isEngineeringRole(p.title)) continue;
    const scored = scoreJob(p, company);
    rows.push({
      source: company.ats,
      externalId: p.externalId,
      company: company.name,
      title: p.title,
      location: p.location,
      url: p.url,
      remote: p.remote,
      department: p.department,
      postedAt: p.postedAt,
      score: scored.score,
      reasons: scored.reasons,
      eligibility: scored.eligibility,
      eligibilityReason: scored.eligibilityReason,
      blockers: scored.blockers,
      regions: scored.regions,
      firstSeenAt: firstSeen.get(p.externalId) ?? now,
      fetchedAt: now,
    });
  }

  // Replace this company's rows atomically enough for our purposes: delete then
  // bulk-insert in chunks (keeps each round trip well under serverless limits).
  await db.delete(jobs).where(eq(jobs.company, company.name));
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(jobs).values(rows.slice(i, i + CHUNK));
  }

  return {
    ...base,
    fetched: result.postings.length,
    kept: rows.length,
    eligible: rows.filter((r) => r.eligibility === "eligible").length,
    blocked: rows.filter((r) => r.eligibility === "blocked").length,
    fresh: rows.filter((r) => !firstSeen.has(r.externalId)).length,
    unchanged: false,
    durationMs: Date.now() - startedAt,
  };
}

/** Same, but never throws — failures come back as `error` on the result. */
export async function refreshCompanySafe(
  company: Company,
  cond?: Conditional,
): Promise<CompanyResult> {
  try {
    return await refreshCompany(company, cond);
  } catch (err) {
    return {
      company: company.name,
      fetched: 0,
      kept: 0,
      eligible: 0,
      blocked: 0,
      fresh: 0,
      unchanged: false,
      durationMs: 0,
      etag: null,
      lastModified: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run `task` over `items`, at most `limit` at a time, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Refresh every company inline, a few boards at a time. This is the
 * fits-in-one-request path (`GET /api/refresh`); the queue is what you want for
 * anything scheduled. Each failure is isolated per company.
 *
 * Note this path sends no ETags — it's the "I want fresh data right now" button.
 */
export async function refreshAll(): Promise<{
  results: CompanyResult[];
  totalKept: number;
  totalEligible: number;
  totalFresh: number;
  failed: number;
}> {
  const results = await mapLimit(companies, FETCH_CONCURRENCY, (c) =>
    refreshCompanySafe(c),
  );
  const sum = (pick: (r: CompanyResult) => number) =>
    results.reduce((n, r) => n + pick(r), 0);
  return {
    results,
    totalKept: sum((r) => r.kept),
    totalEligible: sum((r) => r.eligible),
    totalFresh: sum((r) => r.fresh),
    failed: results.filter((r) => r.error).length,
  };
}
