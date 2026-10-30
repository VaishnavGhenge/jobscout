import { sql } from "drizzle-orm";
import { requireDb } from "@/db/client";
import { jobs, type Job } from "@/db/schema";
import { companies, type Company } from "./companies";
import { AGGREGATOR_SOURCE } from "./aggregate";
import {
  isEngineeringRole,
  scoreJob,
  type CarriedFacts,
  type Scorable,
} from "./scoring";

/**
 * Re-score every stored row against the current profile, without refetching
 * anything.
 *
 * This is the half of the pipeline that was missing. Scoring used to happen
 * exactly once, inside the fetch path, which had three consequences worth
 * naming:
 *
 * - A weight change in profile.ts did nothing until all 84 boards had been
 *   recrawled, so tuning couldn't be tested, only deployed and waited on.
 * - Conditional requests made it worse the better they worked. An unchanged
 *   board answers 304 and `refreshCompany` returns early, so those rows kept
 *   scores from whenever they were last actually rewritten: some from 25 days
 *   before.
 * - Rows scored on different days weren't comparable, which is what a ranked
 *   board is entirely made of.
 *
 * Extraction still happens at fetch time (it needs the network). Everything
 * downstream of the stored text is redone here.
 */

export interface RescoreResult {
  scanned: number;
  /** Rows whose score, reasons or eligibility actually moved. */
  changed: number;
  /** Rows now failing `isEngineeringRole`, e.g. a new title exclusion. */
  dropped: number;
  /**
   * Rows rescored with their body-derived facts carried forward rather than
   * re-parsed, because no description is stored for them.
   *
   * Not a migration state. SmartRecruiters and Rippling need one request per
   * posting for the body, so lib/connectors/detail.ts fetches it only where it
   * could change the verdict: a role in a region you'd need sponsorship for is
   * blocked on location alone and never gets one. Those rows are permanent.
   *
   * Skipping them was the first attempt and it was wrong. A skipped row keeps its
   * old `reasons`, so 75 of them went on displaying "posted <3d" next to a live
   * age of 25 days, which is the bug this whole change exists to fix. Carrying
   * the facts (see `CarriedFacts`) rescores them without inventing anything.
   */
  carriedFacts: number;
  durationMs: number;
}

const CHUNK = 200;

/**
 * Aggregator rows carry no curated `hiresIn`, so their eligibility has to come
 * from the posting's own location. Same synthetic company the ingest path uses,
 * so a rescore can't quietly disagree with the row it's replacing.
 */
const byName = new Map(companies.map((c) => [c.name, c]));

function companyFor(row: Job): Company {
  return (
    byName.get(row.company) ?? {
      name: row.company,
      ats: "greenhouse",
      token: "",
      hiresIn: [],
      tags: ["aggregator"],
    }
  );
}

/** Everything scoring needs, rebuilt from the stored row. */
function scorable(row: Job): Scorable {
  return {
    title: row.title,
    description: row.description,
    location: row.location,
    locations: row.locations,
    countryCode: row.countryCode,
  };
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

type Patch = { id: number } & Pick<
  Job,
  | "score"
  | "reasons"
  | "eligibility"
  | "eligibilityReason"
  | "compLabel"
  | "yoeMin"
  | "yoeMax"
  | "blockers"
  | "regions"
>;

/**
 * Apply a batch of patches in one statement.
 *
 * One UPDATE per row is the obvious version and it's unusable: the board is
 * nearly four thousand rows and every round trip to Neon over HTTP costs tens of
 * milliseconds, which puts a full rescore several minutes past the request
 * timeout it's called from. An UPDATE ... FROM (VALUES ...) does a chunk at a
 * time in a single trip.
 */
async function applyPatches(
  db: ReturnType<typeof requireDb>,
  batch: Patch[],
): Promise<void> {
  const values = batch.map(
    (p) => sql`(${p.id}::int,
      ${p.score}::int,
      ${JSON.stringify(p.reasons)}::jsonb,
      ${p.eligibility}::eligibility_level,
      ${p.eligibilityReason}::text,
      ${p.compLabel}::text,
      ${p.yoeMin}::int,
      ${p.yoeMax}::int,
      ${JSON.stringify(p.blockers)}::jsonb,
      ${JSON.stringify(p.regions)}::jsonb)`,
  );

  await db.execute(sql`
    update jobs as j set
      score = v.score,
      reasons = v.reasons,
      eligibility = v.eligibility,
      eligibility_reason = v.eligibility_reason,
      comp_label = v.comp_label,
      yoe_min = v.yoe_min,
      yoe_max = v.yoe_max,
      blockers = v.blockers,
      regions = v.regions
    from (values ${sql.join(values, sql`, `)}) as v(
      id, score, reasons, eligibility, eligibility_reason,
      comp_label, yoe_min, yoe_max, blockers, regions
    )
    where j.id = v.id`);
}

export async function rescoreAll(): Promise<RescoreResult> {
  const db = requireDb();
  const startedAt = Date.now();

  const rows = await db.select().from(jobs);
  let dropped = 0;
  let carriedFacts = 0;
  const removeIds: number[] = [];
  const patches: Patch[] = [];

  for (const row of rows) {
    // A title exclusion added since this row was written should take effect
    // here too, otherwise the only way to clear one is to wait for the board it
    // came from to change. Safe without a description: the title is enough.
    if (!isEngineeringRole(row.title)) {
      removeIds.push(row.id);
      dropped++;
      continue;
    }

    // With no stored body, the pay band, the visa blockers and any experience
    // ask that isn't in the title cannot be re-derived: parsing an empty string
    // would report "none found" and overwrite each fact with its absence. Hand
    // them to the scorer instead of letting it guess.
    let carry: CarriedFacts | undefined;
    if (!row.description) {
      carriedFacts++;
      carry = {
        blockers: row.blockers,
        compLabel: row.compLabel,
        yoeMin: row.yoeMin,
        yoeMax: row.yoeMax,
      };
    }

    const scored = scoreJob(scorable(row), companyFor(row), carry);

    const unchanged =
      scored.score === row.score &&
      scored.eligibility === row.eligibility &&
      scored.eligibilityReason === row.eligibilityReason &&
      scored.compLabel === row.compLabel &&
      scored.yoeMin === row.yoeMin &&
      scored.yoeMax === row.yoeMax &&
      sameList(scored.reasons, row.reasons) &&
      sameList(scored.blockers, row.blockers) &&
      sameList(scored.regions, row.regions);
    if (unchanged) continue;

    patches.push({
      id: row.id,
      score: scored.score,
      reasons: scored.reasons,
      eligibility: scored.eligibility,
      eligibilityReason: scored.eligibilityReason,
      compLabel: scored.compLabel,
      yoeMin: scored.yoeMin,
      yoeMax: scored.yoeMax,
      blockers: scored.blockers,
      regions: scored.regions,
    });
  }

  for (let i = 0; i < patches.length; i += CHUNK) {
    await applyPatches(db, patches.slice(i, i + CHUNK));
  }

  for (let i = 0; i < removeIds.length; i += CHUNK) {
    const slice = removeIds.slice(i, i + CHUNK);
    await db.delete(jobs).where(sql`${jobs.id} = any(${slice})`);
  }

  return {
    scanned: rows.length,
    changed: patches.length,
    dropped,
    carriedFacts,
    durationMs: Date.now() - startedAt,
  };
}

/** Sources a rescore covers, for the "what did this touch" line in the UI. */
export const rescoreSources = [
  ...new Set([...companies.map((c) => c.ats), AGGREGATOR_SOURCE]),
];
