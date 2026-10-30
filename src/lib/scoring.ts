import { profile } from "./profile";
import { assessEligibility, type Eligibility } from "./eligibility";
import { parseComp } from "./comp";
import { parseYoe, parseYoeFromTitle } from "./yoe";
import { includesAny, matchTerms } from "./match";
import type { Company } from "./companies";
import type { Region } from "./regions";

/**
 * The minimum a posting has to carry to be scored. Both a freshly fetched
 * `RawPosting` and a stored `jobs` row satisfy it, which is the point: scoring
 * has to be re-runnable over what's already in the database, without refetching
 * 84 boards to find out whether a weight change helped.
 */
export interface Scorable {
  title: string;
  description: string;
  location: string;
  locations: string[];
  countryCode: string | null;
}

/**
 * Facts already established for a posting whose description isn't available.
 *
 * Scoring is otherwise a pure function of the stored row, which is what makes it
 * re-runnable. These three are the exception: they can only come from the body,
 * so for a row that never had one stored, parsing an empty string would replace
 * a known fact with its absence rather than with "unknown". Carrying them lets
 * such a row be rescored instead of skipped, which matters because a skipped row
 * keeps its old `reasons` and goes on displaying a freshness it no longer has.
 */
export interface CarriedFacts {
  blockers: string[];
  compLabel: string | null;
  yoeMin: number | null;
  yoeMax: number | null;
}

export interface Scored {
  /**
   * Fit, 0-100, and deliberately time-independent. Freshness is added on read
   * (see lib/freshness.ts), because a stored score that includes decay starts
   * lying the day after it's written.
   */
  score: number;
  reasons: string[];
  eligibility: Eligibility;
  eligibilityReason: string;
  blockers: string[];
  regions: Region[];
  /** Stated pay band, when the posting publishes one. Never scored, see comp.ts. */
  compLabel: string | null;
  yoeMin: number | null;
  yoeMax: number | null;
}

/**
 * Scores a posting for "is this worth an application?".
 *
 * What's here is what varies between two roles you could actually apply to:
 * level, stack, discipline and the experience ask. Eligibility and freshness are
 * both handled elsewhere and for the same reason: inside the set you browse they
 * were near-constant (98% eligible, 76% posted within a week) while together
 * holding half the scale. Points that every row earns equally are not a ranking
 * signal, they're a baseline with extra steps.
 *
 * Tune everything from src/lib/profile.ts, then hit Rescore.
 */
export function scoreJob(
  job: Scorable,
  company: Company,
  carry?: CarriedFacts,
): Scored {
  // Not lowercased. `matchTerms` is case-insensitive by default, and a couple of
  // terms ("go") need the original case to tell the language from the verb.
  const title = job.title;
  const description = job.description;
  const w = profile.weights;
  const reasons: string[] = [];
  let score: number = w.base;

  // --- Eligibility: a filter and a ceiling, not points ----------------------
  const assessment = assessEligibility(job, company, carry?.blockers);

  // --- Role ----------------------------------------------------------------
  const roleHits = matchTerms(title, profile.roleKeywords);
  if (roleHits.length) {
    score += w.roleMatch;
    reasons.push(`role match: ${roleHits[0]}`);
  }

  // --- Level band -----------------------------------------------------------
  // Exactly one tier applies, worst-first: "Lead Software Engineer II" is a
  // lead role that happens to carry a II, not a role in your band.
  const avoidHits = matchTerms(title, profile.seniority.avoid);
  const stretchHits = matchTerms(title, profile.seniority.stretch);
  const targetHits = matchTerms(title, profile.seniority.target);
  if (avoidHits.length) {
    score += w.levelAvoid;
    reasons.push(`off-level: ${avoidHits.join(", ")}`);
  } else if (stretchHits.length) {
    score += w.levelStretch;
    reasons.push(`stretch level: ${stretchHits[0]}`);
  } else if (targetHits.length) {
    score += w.levelMatch;
    reasons.push(`target level: ${targetHits[0]}`);
  }

  // An adjacent discipline is a real engineering job, just not the one you do.
  const offDomainHits = matchTerms(title, profile.offStackDomains);
  if (offDomainHits.length) {
    score += w.offStack;
    reasons.push(`off-stack: ${offDomainHits[0]}`);
  }

  // --- Stack ---------------------------------------------------------------
  // A title that leads with a stack you don't work in is describing a different
  // job. Without this, ".NET Full Stack Developer" and "Full stack (Python)
  // Developer" scored identically, because on-stack terms could only ever add.
  const offTechHits = matchTerms(title, profile.offStackTech);
  if (offTechHits.length) {
    score += w.offStackTech;
    reasons.push(`other stack: ${offTechHits.slice(0, 3).join(", ")}`);
  }

  // Prefer stack in the title (a deliberate signal) over stack in the body
  // (every JD lists a dozen technologies).
  const titleTech = matchTerms(title, profile.techKeywords);
  const bodyTech = matchTerms(description, profile.techKeywords);
  if (titleTech.length) {
    score += w.techMatch;
    reasons.push(`stack: ${titleTech.slice(0, 3).join(", ")}`);
  } else if (bodyTech.length) {
    score += w.techMatchBody;
    reasons.push(`stack in JD: ${bodyTech.slice(0, 3).join(", ")}`);
  }

  // --- Experience ask ------------------------------------------------------
  // Scored as a gap above your own experience, not as a gate: a large gap costs
  // a lot, a small one costs nothing, and no posting is dropped for it.
  //
  // Title first, then anything carried, then the body. The title wins even over
  // a carried value: reading the ask out of a title is new, so a row scored
  // before that existed can legitimately gain one here.
  const yoe =
    parseYoeFromTitle(job.title) ??
    (carry && carry.yoeMin !== null
      ? { min: carry.yoeMin, max: carry.yoeMax }
      : null) ??
    parseYoe(job.description);
  if (yoe) {
    const gap = yoe.min - profile.yearsExperience;
    const tier =
      profile.yoeGap.find((t) => gap <= t.maxGap) ??
      profile.yoeGap[profile.yoeGap.length - 1];
    score += tier.points;
    if (tier.points !== 0) reasons.push(tier.label);
  } else {
    score += profile.yoeUnknown.points;
    reasons.push(profile.yoeUnknown.label);
  }

  // A role you can't be hired for is never a good application, however well the
  // title fits: cap it so it sinks below everything actionable.
  const ceiling = assessment.eligibility === "blocked" ? w.blockedCap : 100;
  score = Math.max(0, Math.min(ceiling, score));

  return {
    score,
    reasons,
    eligibility: assessment.eligibility,
    eligibilityReason: assessment.reason,
    blockers: assessment.blockers,
    regions: assessment.regions,
    compLabel: parseComp(job.description)?.label ?? carry?.compLabel ?? null,
    yoeMin: yoe?.min ?? null,
    yoeMax: yoe?.max ?? null,
  };
}

/**
 * True if the title is engineering-ish enough to keep in the DB at all.
 * Exclusions win: "Customer Engineer" contains "engineer" but is a sales role.
 *
 * Substring-matched on purpose, unlike everything in scoreJob. Several entries
 * in `titleExclusions` carry deliberate surrounding whitespace to control their
 * own boundaries (" it systems" must not fire on "Credit Systems Engineer"),
 * and term matching would strip that control away.
 */
export function isEngineeringRole(title: string): boolean {
  const t = title.toLowerCase();
  if (includesAny(t, profile.titleExclusions).length) return false;
  return includesAny(t, profile.engineeringGate).length > 0;
}
