import { profile } from "./profile";
import { assessEligibility, type Eligibility } from "./eligibility";
import { parseComp } from "./comp";
import { daysSince } from "./time";
import type { Company } from "./companies";
import type { RawPosting } from "./connectors";
import type { Region } from "./regions";

export interface Scored {
  score: number;
  reasons: string[];
  eligibility: Eligibility;
  eligibilityReason: string;
  blockers: string[];
  regions: Region[];
  ageDays: number | null;
  /** Stated pay band, when the posting publishes one. Never scored — see comp.ts. */
  compLabel: string | null;
}

const includesAny = (haystack: string, needles: readonly string[]) =>
  needles.filter((n) => haystack.includes(n));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-boundary variant of `includesAny`. Seniority terms need this: a plain
 * substring test can't tell "Lead Engineer" from "leadership", or "Engineer II"
 * from "Engineer VIII".
 */
const matchesAny = (haystack: string, needles: readonly string[]) =>
  needles.filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`, "i").test(haystack));

/**
 * Scores a posting 0-100 for "is this worth an application?".
 *
 * The two heaviest factors are eligibility (can you be hired for it at all) and
 * freshness (is the req still live), because those are what actually decide
 * whether anyone replies. Title and stack matching are tiebreakers — almost
 * every engineering posting matches those, so weighting them highly just
 * flattens the board into one undifferentiated blob.
 *
 * Tune everything from src/lib/profile.ts.
 */
export function scoreJob(job: RawPosting, company: Company): Scored {
  const title = job.title.toLowerCase();
  const description = job.description.toLowerCase();
  const w = profile.weights;
  const reasons: string[] = [];
  let score: number = w.base;

  // --- Eligibility: the dominant factor -------------------------------------
  const assessment = assessEligibility(job, company);
  if (assessment.eligibility === "eligible") {
    score += w.eligible;
    reasons.push(assessment.reason);
  } else if (assessment.eligibility === "longshot") {
    score += w.longshot;
    reasons.push(`long shot: ${assessment.reason}`);
  } else {
    reasons.push(`blocked: ${assessment.reason}`);
  }

  // --- Freshness ------------------------------------------------------------
  const ageDays = daysSince(job.postedAt);
  if (ageDays === null) {
    score += w.unknownAge;
    reasons.push("no posting date");
  } else {
    const tier = profile.freshness.find((t) => ageDays <= t.maxDays);
    if (tier) {
      score += tier.points;
      reasons.push(tier.label);
    }
  }

  // --- Fit tiebreakers ------------------------------------------------------
  const roleHits = includesAny(title, profile.roleKeywords);
  if (roleHits.length) {
    score += w.roleMatch;
    reasons.push(`role match: ${roleHits[0]}`);
  }

  // --- Level band -----------------------------------------------------------
  // Exactly one tier applies, worst-first: "Lead Software Engineer II" is a
  // lead role that happens to carry a II, not a role in your band.
  const avoidHits = matchesAny(title, profile.seniority.avoid);
  const stretchHits = matchesAny(title, profile.seniority.stretch);
  const targetHits = matchesAny(title, profile.seniority.target);
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
  // Word-boundary matched, not substring: "ios" lives inside "kiosk" and
  // "scenarios", and a plain `includes` would flag both.
  const offStackHits = matchesAny(title, profile.offStackDomains);
  if (offStackHits.length) {
    score += w.offStack;
    reasons.push(`off-stack: ${offStackHits[0]}`);
  }

  // Prefer stack in the title (a deliberate signal) over stack in the body
  // (every JD lists a dozen technologies).
  const titleTech = includesAny(title, profile.techKeywords);
  const bodyTech = includesAny(description, profile.techKeywords);
  if (titleTech.length) {
    score += w.techMatch;
    reasons.push(`stack: ${titleTech.join(", ")}`);
  } else if (bodyTech.length) {
    score += Math.round(w.techMatch / 2);
    reasons.push(`stack in JD: ${bodyTech.slice(0, 3).join(", ")}`);
  }

  // A role you can't be hired for is never a good application, however well the
  // title fits — cap it so it sinks below everything actionable.
  const ceiling =
    assessment.eligibility === "blocked" ? w.blockedCap : 100;
  score = Math.max(0, Math.min(ceiling, score));

  return {
    score,
    reasons,
    eligibility: assessment.eligibility,
    eligibilityReason: assessment.reason,
    blockers: assessment.blockers,
    regions: assessment.regions,
    ageDays,
    compLabel: parseComp(job.description)?.label ?? null,
  };
}

/**
 * True if the title is engineering-ish enough to keep in the DB at all.
 * Exclusions win: "Customer Engineer" contains "engineer" but is a sales role.
 */
export function isEngineeringRole(title: string): boolean {
  const t = title.toLowerCase();
  if (profile.titleExclusions.some((k) => t.includes(k))) return false;
  return profile.engineeringGate.some((k) => t.includes(k));
}
