/**
 * Pull the years-of-experience requirement out of a posting.
 *
 * This *is* scored now (see profile.yoeGap). It used to be display-only on the
 * grounds that a stated number is a wish rather than a gate, which is true, and
 * it's still not a gate: the gap above your own experience costs points on a
 * sliding scale and nothing is dropped for it. What isn't defensible is
 * ignoring it, which let "Software Engineering Technical Leader | Golang
 * (12-15 Years)" score 98 for a two-year candidate.
 *
 * Two parsers, because the title and the body carry the number under opposite
 * conventions:
 *
 * - In a description, years are everywhere. "4 year vesting with a 1 year
 *   cliff", "over the past 10 years we've grown", "founded 8 years ago" all
 *   parse identically to a requirement, so a match only counts when an
 *   experience word sits next to it and no vesting or company-history word
 *   does.
 * - In a title there is no prose to disambiguate, and no vesting schedule
 *   either. "_4Yrs_", "- 9 yrs -", "(12-15 Years)", "// 5.5 - 8 years //" are
 *   the requirement, stated bluntly, and requiring a nearby "experience" would
 *   miss every one of them. This is the Indian-market convention and the ATS
 *   parsers never saw it, because they only ever read the body.
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

/**
 * Numbers in a title, with decimals allowed: Indian listings write "5.5 - 8
 * years" and truncating that to "5" understates the ask.
 */
const TITLE_PATTERNS: { re: RegExp; range: boolean }[] = [
  {
    re: new RegExp(
      String.raw`(\d{1,2}(?:\.\d)?)${SEP}(\d{1,2}(?:\.\d)?)\s*\+?\s*${Y}`,
      "i",
    ),
    range: true,
  },
  {
    re: new RegExp(String.raw`(\d{1,2}(?:\.\d)?)\s*\+?\s*${Y}`, "i"),
    range: false,
  },
];

/**
 * The few things "N years" can mean in a title that aren't a requirement. Much
 * shorter than the description guard: a title has no equity section, no company
 * history and no benefits list.
 */
const TITLE_NOT_EXPERIENCE_RE = /\b(contract|notice period|bond|old)\b/i;

/**
 * Read the requirement out of a *title*. Returns null when the title carries no
 * number, which is most of them.
 */
export function parseYoeFromTitle(title: string): Yoe | null {
  if (!title) return null;
  if (TITLE_NOT_EXPERIENCE_RE.test(title)) return null;

  for (const { re, range } of TITLE_PATTERNS) {
    const m = re.exec(title);
    if (!m) continue;

    // Round down: a role asking "5.5 years" is asking for five-and-change, and
    // the gap tiers are whole numbers.
    const min = Math.floor(Number(m[1]));
    const max = range ? Math.floor(Number(m[2])) : null;
    if (!Number.isFinite(min) || min > MAX_PLAUSIBLE) continue;
    if (max !== null && (max <= min || max > MAX_PLAUSIBLE * 2)) continue;
    if (min === 0 && max === null) continue;

    return { min, max };
  }

  return null;
}

/** Compact badge text: "2+ yrs", "3–5 yrs". */
export function formatYoe(min: number, max: number | null): string {
  return max !== null ? `${min}–${max} yrs` : `${min}+ yrs`;
}
