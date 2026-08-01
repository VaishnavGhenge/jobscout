/**
 * Pull the years-of-experience requirement out of a job description.
 *
 * Like comp.ts, this is display-only and deliberately not part of scoring. The
 * number a JD prints is a wish, not a gate — plenty of "5+ years" reqs hire at
 * three — so ranking on it would bury roles that are worth an application.
 * Showing it lets you make that call yourself.
 *
 * The parsing risk here is the opposite of comp.ts's: years are everywhere in a
 * JD. "4 year vesting with a 1 year cliff", "over the past 10 years we've
 * grown", "founded 8 years ago" all parse identically to a requirement. So a
 * match only counts when an experience word sits next to it and no vesting or
 * company-history word does.
 */

export interface Yoe {
  /** Lower bound of the stated requirement. "5+ years" -> 5. */
  min: number;
  /** Upper bound when the posting states a range, else null. */
  max: number | null;
}

const Y = String.raw`(?:years?|yrs?\.?)`;
const SEP = String.raw`\s*(?:-|–|—|to)\s*`;

/**
 * Tried in order, first confident match wins. A JD that opens with "3+ years of
 * backend experience" and later says "5+ years with Kafka preferred" is asking
 * for three; the headline requirement comes first in practice.
 */
const PATTERNS: { re: RegExp; range: boolean }[] = [
  // "3-5 years", "3 to 5 years of experience", "8 to 12 or more years".
  // The "or more" alternative matters: without it the range misses and a later,
  // smaller figure in the same sentence ("...with at least 2 to 3 years leading
  // teams") wins instead, understating the requirement.
  {
    re: new RegExp(
      String.raw`(\d{1,2})${SEP}(\d{1,2})\s*(?:\+|or\s+more)?\s*${Y}`,
      "i",
    ),
    range: true,
  },
  // "5+ years", "5 + yrs"
  { re: new RegExp(String.raw`(\d{1,2})\s*\+\s*${Y}`, "i"), range: false },
  // "minimum 4 years", "at least 2 years of relevant experience"
  {
    re: new RegExp(
      String.raw`(?:minimum|min\.?|at\s*least|atleast|over|more\s+than|no\s+less\s+than)\s+(?:of\s+)?(\d{1,2})\s*${Y}`,
      "i",
    ),
    range: false,
  },
  // "4 years of experience" with nothing qualifying it
  { re: new RegExp(String.raw`(\d{1,2})\s*${Y}`, "i"), range: false },
];

/** Without one of these beside it, a number of years isn't a requirement. */
const EXPERIENCE_RE =
  /\b(experience|exp\b|background|hands[-\s]?on|track record|expertise|proficiency|worked|working)\b/i;

/**
 * Contexts where "N years" means something else entirely. Vesting schedules are
 * the big one — nearly every equity section says "4 year vesting, 1 year cliff",
 * and it sits close enough to "experience" elsewhere in the JD to fool a
 * looser check.
 */
const NOT_EXPERIENCE_RE =
  /\b(vest\w*|cliff|founded|anniversary|in business|over the (?:past|last)|in the (?:past|last)|for the (?:past|last)|years old|notice period|bond|warranty|visa|contract|tenure track|not requir\w*|do(?:es)?n'?t requir\w*|do not requir\w*|no minimum|regardless of)\b/i;

/** Above this a "requirement" is company history or a typo, not a job spec. */
const MAX_PLAUSIBLE = 25;

export function parseYoe(description: string): Yoe | null {
  if (!description) return null;
  const text = description.slice(0, 20_000);

  for (const { re, range } of PATTERNS) {
    // Scan every occurrence, not just the first: the earliest "N years" in a JD
    // is often in the company blurb ("15 years of building..."), and we want the
    // first one that actually reads as a requirement.
    const global = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 120), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 90);
      const window = `${before} ${m[0]} ${after}`;

      if (NOT_EXPERIENCE_RE.test(window)) continue;
      if (!EXPERIENCE_RE.test(window)) continue;

      const min = Number(m[1]);
      const max = range ? Number(m[2]) : null;
      if (!Number.isFinite(min) || min > MAX_PLAUSIBLE) continue;
      if (max !== null && (max <= min || max > MAX_PLAUSIBLE * 2)) continue;
      // "0 years" on its own carries no information; a "0-2" range does.
      if (min === 0 && max === null) continue;

      return { min, max };
    }
  }

  return null;
}

/** Compact badge text: "2+ yrs", "3–5 yrs". */
export function formatYoe(min: number, max: number | null): string {
  return max !== null ? `${min}–${max} yrs` : `${min}+ yrs`;
}
