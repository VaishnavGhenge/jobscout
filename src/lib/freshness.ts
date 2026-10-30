import { sql, type SQL } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { profile } from "./profile";
import { daysSince } from "./time";

/**
 * Freshness, computed when the board is read rather than when the row is
 * written.
 *
 * This module exists because of a bug you could see on the board: a PerkinElmer
 * role showing "25d old" in its meta line and "POSTED <3D" in its badges, on a
 * score of 95. Both numbers were correct. The age was computed live from
 * `posted_at`; the badge and the +25 points were computed on 2 August, when the
 * posting really was one day old, and then stored.
 *
 * Nothing rewrote them, for two reasons that compound:
 *
 * - The aggregator only runs when POST /api/aggregate is called, so its 498 rows
 *   sat untouched for 24 days.
 * - The ATS path is worse, because it looks like it's working. Conditional
 *   requests mean an unchanged board answers 304, `refreshCompany` returns early
 *   and the existing rows keep their original scores. The better the caching
 *   works, the staler the scores get.
 *
 * 553 of 3757 rows were claiming a freshness they no longer had, each one
 * overscored by up to 25 points against roles that had been rescored more
 * recently. A stored time-varying score is wrong the moment it's committed, so
 * the stored score is now time-independent and this is applied on read.
 */

export interface Freshness {
  ageDays: number | null;
  points: number;
  label: string;
}

/** The freshness tier a posting of this age falls into. */
export function freshnessFor(postedAt: Date | string | null): Freshness {
  const ageDays = daysSince(postedAt);
  if (ageDays === null) {
    return { ageDays, ...profile.unknownAge };
  }
  const tier =
    profile.freshness.find((t) => ageDays <= t.maxDays) ??
    profile.freshness[profile.freshness.length - 1];
  return { ageDays, points: tier.points, label: tier.label };
}

/**
 * Fit score plus today's freshness, clamped to the 0-100 the UI draws.
 *
 * `fit` is what's in `jobs.score`: level, stack, discipline and experience, none
 * of which change while the row sits there.
 */
export function effectiveScore(
  fit: number,
  postedAt: Date | string | null,
): number {
  return Math.max(0, Math.min(100, fit + freshnessFor(postedAt).points));
}

/**
 * The same arithmetic in SQL, so the board can filter, sort and paginate on the
 * live number.
 *
 * It has to be SQL rather than a pass over the results: the page query is
 * LIMIT 50 over thousands of rows, so ranking in TypeScript would rank one
 * arbitrary page of the board and call it the top.
 *
 * Generated from `profile.freshness` rather than hand-written, so the tiers
 * can't drift apart from the ones `freshnessFor` uses.
 */
export function effectiveScoreSql(): SQL<number> {
  // Every parameter is cast explicitly. Without them Postgres receives the
  // points as untyped parameters and refuses the expression outright: `integer +
  // unknown` has no operator, so the whole board query fails with 42883 rather
  // than quietly misbehaving.
  const branches = profile.freshness
    .filter((t) => Number.isFinite(t.maxDays))
    .map(
      (t) =>
        sql`when now() - ${jobs.postedAt} <= make_interval(days => ${t.maxDays}::int) then ${t.points}::int`,
    );
  const last = profile.freshness[profile.freshness.length - 1];

  return sql<number>`greatest(0, least(100, ${jobs.score} + case
      when ${jobs.postedAt} is null then ${profile.unknownAge.points}::int
      ${sql.join(branches, sql` `)}
      else ${last.points}::int end))`;
}
