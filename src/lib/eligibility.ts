import type { Company } from "./companies";
import type { RawPosting } from "./connectors";
import { profile, eligibleRegions } from "./profile";
import { parseRegions, regionsInclude, type Region } from "./regions";

/**
 * Can you actually be hired for this, or would you be screened out before a
 * human reads your application?
 *
 * - `eligible` — posted for a region you can work in.
 * - `longshot`  — plausible but unproven: a vague "Global" listing at a company
 *                 with no presence where you are, a broad "APAC" tag, or a
 *                 region-matched role whose description still talks about work
 *                 authorization elsewhere.
 * - `blocked`   — posted somewhere you'd need sponsorship for, or the
 *                 description says outright that sponsorship isn't available.
 */
export type Eligibility = "eligible" | "longshot" | "blocked";

export interface Assessment {
  eligibility: Eligibility;
  regions: Region[];
  /** Verbatim phrases from the description that would screen you out. */
  blockers: string[];
  reason: string;
}

/** Description phrases that mean "you need work authorization we won't give you". */
function findBlockers(description: string): string[] {
  if (!description) return [];
  const text = description.toLowerCase();
  return profile.blockPhrases.filter((p) => text.includes(p));
}

export function assessEligibility(
  posting: RawPosting,
  company: Company,
): Assessment {
  const regions = parseRegions([
    posting.location,
    ...posting.locations,
    posting.countryCode,
  ]);
  const blockers = findBlockers(posting.description);

  const home = profile.basedIn;
  // Deliberately an exact check, not `regionCovers`: a company hiring in APAC
  // (Sydney, Singapore) tells us nothing about whether it hires in India.
  const companyHires =
    company.hiresIn.includes(home) || company.hiresIn.includes("anywhere");

  // An explicit hit on a region you can work in — the strongest signal there is.
  const explicit = regions.some((r) => eligibleRegions.includes(r));
  // A borderless listing ("Global", "Anywhere", "Distributed").
  const borderless = regions.includes("anywhere");
  // A broad bucket that merely contains you ("APAC" might mean Singapore.)
  const broad = !explicit && !borderless && regionsInclude(regions, home);

  if (explicit) {
    if (blockers.length) {
      return {
        eligibility: "longshot",
        regions,
        blockers,
        reason: `posted in your region, but the description restricts work authorization`,
      };
    }
    return { eligibility: "eligible", regions, blockers, reason: "hires where you are" };
  }

  if (borderless) {
    if (blockers.length) {
      return {
        eligibility: "blocked",
        regions,
        blockers,
        reason: `listed as global but requires: ${blockers[0]}`,
      };
    }
    // Some boards file genuinely local roles under a blanket "Distributed" or
    // "Global" location and put the real city in the title — Cloudflare's
    // "Senior Customer Engineer, Majors - Detroit, MI" is listed as Distributed.
    // Trust the more specific of the two.
    const titleRegions = parseRegions([posting.title]).filter(
      (r) => r !== "anywhere",
    );
    if (titleRegions.length && !regionsInclude(titleRegions, home)) {
      return {
        eligibility: "blocked",
        regions: [...new Set([...regions, ...titleRegions])],
        blockers,
        reason: `listed as global, but the title pins it to ${titleRegions.join(", ")}`,
      };
    }
    // "Global" from a company that has never posted a role where you live is
    // usually global-within-their-existing-entities. Worth a shot, not a bet.
    return companyHires
      ? { eligibility: "eligible", regions, blockers, reason: "open globally" }
      : {
          eligibility: "longshot",
          regions,
          blockers,
          reason: "listed as global, but no roles where you are",
        };
  }

  if (broad) {
    return {
      eligibility: "longshot",
      regions,
      blockers,
      reason: "broad region — may not include your location",
    };
  }

  if (blockers.length) {
    return {
      eligibility: "blocked",
      regions,
      blockers,
      reason: blockers[0],
    };
  }

  if (regions.length) {
    return {
      eligibility: "blocked",
      regions,
      blockers,
      reason: `located in ${regions.join(", ")} — you'd need sponsorship`,
    };
  }

  // No parseable location at all. Fall back to what the company does elsewhere.
  return companyHires
    ? {
        eligibility: "longshot",
        regions,
        blockers,
        reason: "location unclear, but this company does hire where you are",
      }
    : {
        eligibility: "blocked",
        regions,
        blockers,
        reason: "location unclear and no roles where you are",
      };
}
