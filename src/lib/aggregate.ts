import { eq, inArray } from "drizzle-orm";
import { requireDb } from "@/db/client";
import { jobs, type NewJob } from "@/db/schema";
import { companies, type Company } from "./companies";
import { isEngineeringRole, scoreJob } from "./scoring";
import { profile } from "./profile";
import { fetchAdzuna, adzunaConfigured, type AdzunaQuery } from "./aggregators/adzuna";

/**
 * Ingest from query-based aggregators, as opposed to the per-company ATS boards
 * in refresh.ts.
 *
 * The two paths can't share code because the shapes disagree: a board is one
 * company and its rows are replaced by company name, whereas an aggregator
 * returns many companies at once and its rows are replaced by *source*. Trying
 * to force an aggregator through refreshCompany() would stamp every posting
 * with the aggregator's name as the employer.
 */

export const AGGREGATOR_SOURCE = "adzuna";

/**
 * What to ask Adzuna for. Each runs as a separate query, so keep the list short
 * — the free tier is rate-limited and overlapping queries mostly return the
 * same rows. These deliberately mirror profile.roleKeywords rather than being a
 * second, drifting copy of your search.
 */
export const QUERIES: AdzunaQuery[] = [
  { country: "in", what: "backend engineer", maxDaysOld: 30 },
  { country: "in", what: "software engineer", maxDaysOld: 30 },
  { country: "in", what: "full stack developer", maxDaysOld: 30 },
  { country: "in", what: "python developer", maxDaysOld: 30 },
  { country: "in", what: "golang developer", maxDaysOld: 30 },
];

export interface AggregateResult {
  source: string;
  fetched: number;
  /** Dropped because a curated board already carries the same role. */
  duplicates: number;
  /** Dropped because the "employer" is a reposting platform. */
  reposts: number;
  kept: number;
  eligible: number;
  fresh: number;
  durationMs: number;
  error?: string;
}

/** True when the company name is a platform relisting someone else's role. */
function isReposter(company: string): boolean {
  const c = company.toLowerCase();
  return profile.repostBlocklist.some((name) => c.includes(name));
}

/**
 * Aggregator rows carry no curated `hiresIn`, so eligibility has to be decided
 * from the posting's own location. An empty list is the conservative reading:
 * a borderless listing from an unknown employer becomes a longshot rather than
 * being waved through as eligible.
 */
function syntheticCompany(name: string): Company {
  return { name, ats: "greenhouse", token: "", hiresIn: [], tags: ["aggregator"] };
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Company + title, loosely normalized — enough to spot the same role twice.
 *
 * Only the *first* word of the company is used, because aggregators report
 * registered names ("Razorpay Software Private Limited") where an ATS board
 * reports the brand ("Razorpay"), and no suffix list keeps up with that. The
 * trade is that two unrelated companies sharing a first word and an identical
 * title collapse into one — "Zeta" the fintech and "Zeta Global" the adtech firm
 * would. That only ever costs us one aggregator row, so it's the cheap error to
 * make.
 */
function dedupeKey(company: string, title: string): string {
  const brand = normalize(company).split(" ")[0] ?? "";
  return `${brand}::${normalize(title)}`;
}

/**
 * Fetch every query, drop anything a curated board already has, score the rest
 * and replace this source's rows.
 *
 * Deduping matters more than it looks. Adzuna carries the same Rippling and
 * Razorpay reqs the ATS connectors already pull, and the jobs table is unique on
 * (source, externalId) — so without this the board would show each of those
 * twice, once per source, with different scores.
 */
export async function refreshAggregator(): Promise<AggregateResult> {
  const db = requireDb();
  const startedAt = Date.now();
  const base = { source: AGGREGATOR_SOURCE, fetched: 0, duplicates: 0, reposts: 0, kept: 0, eligible: 0, fresh: 0 };

  if (!adzunaConfigured()) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      error: "ADZUNA_APP_ID / ADZUNA_APP_KEY not set — see lib/aggregators/adzuna.ts",
    };
  }

  // Everything the curated boards already cover. Compared on company+title
  // because the same req has a different id in every system.
  const curated = await db
    .select({ company: jobs.company, title: jobs.title })
    .from(jobs)
    .where(
      inArray(
        jobs.source,
        [...new Set(companies.map((c) => c.ats))],
      ),
    );
  const seenElsewhere = new Set(curated.map((r) => dedupeKey(r.company, r.title)));

  const existing = await db
    .select({ externalId: jobs.externalId, firstSeenAt: jobs.firstSeenAt })
    .from(jobs)
    .where(eq(jobs.source, AGGREGATOR_SOURCE));
  const firstSeen = new Map(existing.map((r) => [r.externalId, r.firstSeenAt]));

  const now = new Date();
  const seen = new Set<string>();
  const rows: NewJob[] = [];
  let fetched = 0;
  let duplicates = 0;
  let reposts = 0;

  for (const q of QUERIES) {
    const results = await fetchAdzuna(q);
    fetched += results.length;

    for (const { posting, company } of results) {
      if (seen.has(posting.externalId)) continue;
      seen.add(posting.externalId);
      if (!isEngineeringRole(posting.title)) continue;
      if (isReposter(company)) {
        reposts++;
        continue;
      }

      const key = dedupeKey(company, posting.title);
      if (seenElsewhere.has(key)) {
        duplicates++;
        continue;
      }
      seenElsewhere.add(key);

      const scored = scoreJob(posting, syntheticCompany(company));
      rows.push({
        source: AGGREGATOR_SOURCE,
        externalId: posting.externalId,
        company,
        title: posting.title,
        location: posting.location,
        url: posting.url,
        remote: posting.remote,
        department: posting.department,
        postedAt: posting.postedAt,
        score: scored.score,
        reasons: scored.reasons,
        eligibility: scored.eligibility,
        eligibilityReason: scored.eligibilityReason,
        compLabel: scored.compLabel,
        yoeMin: scored.yoeMin,
        yoeMax: scored.yoeMax,
        blockers: scored.blockers,
        regions: scored.regions,
        firstSeenAt: firstSeen.get(posting.externalId) ?? now,
        fetchedAt: now,
      });
    }
  }

  await db.delete(jobs).where(eq(jobs.source, AGGREGATOR_SOURCE));
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(jobs).values(rows.slice(i, i + CHUNK));
  }

  return {
    source: AGGREGATOR_SOURCE,
    fetched,
    duplicates,
    reposts,
    kept: rows.length,
    eligible: rows.filter((r) => r.eligibility === "eligible").length,
    fresh: rows.filter((r) => !firstSeen.has(r.externalId)).length,
    durationMs: Date.now() - startedAt,
  };
}
