import { profile } from "./profile";
import { cityOf, locationVerdict } from "./location-pref";
import { parseComp } from "./comp";
import { parseYoe, parseYoeFromTitle, type Yoe } from "./yoe";
import { matchTerms } from "./match";

/**
 * Would you actually apply? A hard filter, run before ranking, used by the
 * MCP searches and the watcher. The board keeps scoring everything; this is
 * for the places where a row you can't send an application to is pure noise.
 *
 * Four questions, in order:
 *
 * 1. Is the title a role you do? Frontend-only titles are dropped unless the
 *    title also says backend or full stack.
 * 2. Can you apply? A stated minimum above `profile.maxYoeAsk` is a no. A
 *    missing ask is kept: most Indian JDs never state one.
 * 3. Is it your stack? Python or Go has to appear in the title or the JD. When
 *    the JD wasn't fetched the row is kept, since absence proves nothing.
 * 4. Is it somewhere you'd work? Your cities or remote, per location-pref.ts.
 *    Anywhere else in India passes only when the pay clears the override floor,
 *    either stated in the JD or from a salary lookup.
 *
 * The pay floor is read from PAY_OVERRIDE_LPA in .env, not from profile.ts:
 * the repo is public and a salary figure is personal. Unset means no override.
 */
export interface GateInput {
  title: string;
  location: string;
  description: string;
  /** An ask already parsed elsewhere (posts have their own parser). */
  yoe?: Yoe | null;
  /** Median from salary_lookup, in lakhs per year, when one is cached. */
  estimateLpa?: number | null;
  /** Which figures that median came from: the job's city, or "India". */
  estimateWhere?: string | null;
}

export interface GateVerdict {
  ok: boolean;
  /** Why it was dropped. */
  why: string | null;
  /** Location label for the row. */
  where: string;
  /** Pay shown on the row: stated in the JD, or an estimate marked "est.". */
  pay: string | null;
  /** The estimate (not stated pay) is below CURRENT_CTC_LPA: flagged and ranked down, not dropped. */
  belowCurrent?: boolean;
}

const LOCALS_ONLY =
  /\b(?:[a-z]+ )?candidates only\b(?![^.\n]{0,15}preferred)|only (?:candidates )?(?:currently )?(?:residing|based|located|living) in|(?:relocation|outstation)[^.\n]{0,40}(?:not (?:allowed|considered|eligible)|strictly)|only local candidates(?!\s*(?:are\s*)?preferred)|local candidates only(?!\s*preferred)/i;

/**
 * Your current pay, from CURRENT_CTC_LPA in .env (personal, never in the
 * repo). A move has to pay more than this.
 */
export function currentCtcLpa(): number | null {
  const n = Number(process.env.CURRENT_CTC_LPA);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function payFloorLpa(): number | null {
  const n = Number(process.env.PAY_OVERRIDE_LPA);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function fitGate(j: GateInput): GateVerdict {
  const stated = parseComp(j.description);
  const statedLpa = stated?.currency === "INR" ? (stated.max ?? stated.min) / 100_000 : null;
  const pay = stated?.label ?? (j.estimateLpa ? `est. ₹${j.estimateLpa}L${j.estimateWhere ? ` ${j.estimateWhere}` : ""}` : null);
  const where = locationVerdict(j.location, j.description);
  const current = currentCtcLpa();
  // Stated pay is the employer's own number: at or below what you earn now, it's not a move.
  // An estimate is crowd-sourced and often for another level, so it only flags.
  const belowCurrent = !!current && !statedLpa && !!j.estimateLpa && j.estimateLpa < current;
  const drop = (why: string): GateVerdict => ({ ok: false, why, where: where.label, pay, belowCurrent });

  const scope = profile.roleScope;
  if (matchTerms(j.title, scope.excludeTitles).length && !matchTerms(j.title, scope.unlessTitle).length) {
    return drop("frontend-only title");
  }

  // Lead, Staff, Principal and the like want 6+ years whether or not the JD says so.
  const offLevel = matchTerms(j.title, profile.seniority.avoid);
  if (offLevel.length) return drop(`off-level title (${offLevel[0]})`);

  if (current && statedLpa !== null && statedLpa <= current) return drop("stated pay at or below your current");

  const yoe = j.yoe ?? parseYoeFromTitle(j.title) ?? parseYoe(j.description);
  if (yoe && yoe.min > profile.maxYoeAsk) return drop(`asks ${yoe.min}+ yrs`);

  const stack = profile.requiredStack;
  const hasBody = j.description.length > 200;
  if (!matchTerms(j.title, stack).length && hasBody && !matchTerms(j.description, stack).length) {
    return drop("no Python or Go in title or JD");
  }

  // "Mumbai candidates only, relocation strictly not allowed": you can't
  // apply from another city however well the rest fits. "Local candidates
  // preferred" is a preference and passes.
  const home = process.env.HOME_CITY ? cityOf(process.env.HOME_CITY) : null;
  const jobCity = cityOf(j.location) ?? cityOf(j.description.slice(0, 1500));
  if (home && jobCity && jobCity !== home && LOCALS_ONLY.test(j.description)) return drop(`local candidates only (${jobCity})`);

  if (where.ok) return { ok: true, why: null, where: where.label, pay, belowCurrent };

  // Outside your cities: only a high enough offer brings it back.
  const floor = payFloorLpa();
  const best = statedLpa ?? j.estimateLpa ?? null;
  if (floor && best && best >= floor) {
    return { ok: true, why: null, where: `${where.label} (pays ₹${Math.round(best)}L${statedLpa ? "" : " est."})`, pay, belowCurrent };
  }
  return drop(where.why ?? "location");
}

/** "on-site in Gurugram, Haryana, India, not one of your cities" -> "outside your cities". */
export function dropKey(why: string): string {
  if (/not one of your cities|no visa sponsorship|remote, but limited/.test(why)) return "location";
  if (/^asks \d+/.test(why)) return `asks ${profile.maxYoeAsk + 1}+ yrs`;
  if (why.startsWith("local candidates only")) return "locals only";
  if (why.startsWith("off-level")) return "lead/staff level";
  if (why.startsWith("stated pay at or below")) return "pays at or below current";
  return why;
}
