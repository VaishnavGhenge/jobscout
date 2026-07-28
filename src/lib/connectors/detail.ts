import { eligibleRegions } from "../profile";
import { parseRegions } from "../regions";
import { isEngineeringRole } from "../scoring";
import type { RawPosting } from "./types";

/**
 * Support for boards that don't hand back descriptions in the list call.
 *
 * Greenhouse, Lever and Ashby all return the full posting in one request.
 * SmartRecruiters and Rippling don't — the description needs a request per
 * posting, which is the difference between one HTTP call per board and several
 * hundred. Fetching all of them would be both slow and rude, so we fetch the
 * ones where the description can actually change the outcome.
 */

/**
 * Is this posting's description worth an HTTP request?
 *
 * The description feeds exactly one decision: `blockPhrases` in
 * lib/eligibility.ts. Reading that logic, blockers only ever change the verdict
 * for postings that are already in play:
 *
 * - explicitly in a region you can work in  → blockers demote eligible → longshot
 * - borderless ("Global", "Remote")         → blockers demote it to blocked
 * - no parseable location at all            → falls back to company footprint
 *
 * A posting explicitly located somewhere you'd need sponsorship is `blocked` on
 * its location alone, and nothing in its text can change that — so we don't ask
 * for it. Same for a broad-bucket region ("APAC"), which is `longshot` either
 * way. On Rippling's own board this is the difference between 138 requests and
 * roughly half that.
 */
export function descriptionCouldMatter(posting: RawPosting): boolean {
  if (!isEngineeringRole(posting.title)) return false;

  const regions = parseRegions([
    posting.location,
    ...posting.locations,
    posting.countryCode,
  ]);

  if (regions.length === 0) return true; // location unclear
  if (regions.includes("anywhere")) return true; // borderless
  return regions.some((r) => eligibleRegions.includes(r)); // where you can work
}

export interface HydrateOptions {
  /** Detail requests in flight at once. Kept low on purpose. */
  concurrency?: number;
  /** Hard ceiling on requests per board, whatever the filter says. */
  cap?: number;
  /** Wall-clock budget, so one board can't eat a worker invocation. */
  budgetMs?: number;
}

export interface HydrateResult {
  fetched: number;
  /** Left without a description: over the cap, out of time, or the call failed. */
  skipped: number;
}

/**
 * Fill in details for `postings`, in place, within a bounded number of requests
 * and a bounded amount of time.
 *
 * A posting that can't be hydrated keeps its empty description rather than
 * failing the board: a missing description costs us blocker detection on that
 * one role, which is a far better outcome than losing the whole company's board.
 */
export async function hydrate<T extends RawPosting>(
  postings: T[],
  fetchOne: (posting: T) => Promise<void>,
  options: HydrateOptions = {},
): Promise<HydrateResult> {
  const { concurrency = 4, cap = 90, budgetMs = 15_000 } = options;
  const deadline = Date.now() + budgetMs;
  const queue = postings.slice(0, cap);
  let cursor = 0;
  let fetched = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (cursor < queue.length && Date.now() < deadline) {
        const posting = queue[cursor++];
        try {
          await fetchOne(posting);
          fetched++;
        } catch {
          // Leave the description empty and move on.
        }
      }
    },
  );
  await Promise.all(workers);

  return { fetched, skipped: postings.length - fetched };
}
