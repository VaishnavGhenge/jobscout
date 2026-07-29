/**
 * Pull a stated salary range out of a job description.
 *
 * Deliberately *not* part of scoring. Most postings — Indian ones especially —
 * say nothing about pay, so scoring on this would rank roles by whether the
 * company happens to publish a band, which is not the same as whether it pays
 * well. It's shown as a badge and left at that.
 *
 * Only ranges tied to an explicit currency marker are accepted. A bare number in
 * a JD is far more likely to be a team size or a year than a salary.
 */

export interface Comp {
  /** Compact display form, e.g. "₹25L–35L" or "$150k–200k". */
  label: string;
  currency: "INR" | "USD" | "EUR" | "GBP";
  /** Annualized, in whole currency units. */
  min: number;
  max: number | null;
}

const SYMBOL: Record<Comp["currency"], string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Below these, a "range" is a per-hour rate or a typo, not an annual salary. */
const ANNUAL_FLOOR: Record<Comp["currency"], number> = {
  INR: 100_000,
  USD: 20_000,
  EUR: 20_000,
  GBP: 20_000,
};

/**
 * "1,50,000" (Indian grouping), "150,000", "150k" and "1.5" all have to come out
 * as numbers. `scale` carries a multiplier from a trailing unit (L, k, mn).
 */
function toNumber(raw: string, scale = 1): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n * scale : null;
}

const UNIT_SCALE: Record<string, number> = {
  l: 100_000,
  lac: 100_000,
  lacs: 100_000,
  lakh: 100_000,
  lakhs: 100_000,
  lpa: 100_000,
  k: 1_000,
  cr: 10_000_000,
  crore: 10_000_000,
  mn: 1_000_000,
  m: 1_000_000,
};

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
// Longest-first: `l` must not win the race against `lakh`.
const UNIT = String.raw`(lpa|lakhs?|lacs?|crore|cr|mn|l|k|m)?`;
const SEP = String.raw`\s*(?:-|–|—|to|and)\s*`;

/** ₹ / INR / Rs. → INR, $ / USD → USD, and so on. */
function currencyOf(token: string): Comp["currency"] | null {
  const t = token.toLowerCase().replace(/[.\s]/g, "");
  if (t === "₹" || t === "inr" || t === "rs" || t === "rupees") return "INR";
  if (t === "$" || t === "usd" || t === "us$") return "USD";
  if (t === "€" || t === "eur") return "EUR";
  if (t === "£" || t === "gbp") return "GBP";
  return null;
}

const CUR = String.raw`(₹|\$|€|£|INR|USD|EUR|GBP|Rs\.?)`;

// "₹25L - ₹35L", "$150,000 — $200,000", "INR 25,00,000 to 35,00,000"
const RANGE_RE = new RegExp(
  `${CUR}\\s*(${NUM})\\s*${UNIT}${SEP}(?:${CUR}\\s*)?(${NUM})\\s*${UNIT}`,
  "i",
);
// "25 - 35 LPA" — unit carries the currency, no symbol needed.
const LPA_RANGE_RE = new RegExp(
  `(${NUM})${SEP}(${NUM})\\s*(lpa|lakhs?|lacs?)\\b`,
  "i",
);
// Single value: "₹30,00,000 per annum", "30 LPA"
const SINGLE_RE = new RegExp(`${CUR}\\s*(${NUM})\\s*${UNIT}`, "i");
const LPA_SINGLE_RE = new RegExp(`(${NUM})\\s*(lpa|lakhs?|lacs?)\\b`, "i");

/** Rates, not salaries — skip anything worded per-hour/day/month. */
const PER_UNIT_RE = /\/\s*(hour|hr|day|month|mo)\b|per\s+(hour|hour|day|month)\b/i;

/**
 * A currency figure in a JD is just as likely to be a funding round or an ARR
 * number as it is a salary — "we raised $150 million" parses identically to a
 * pay band. Require a word that means *your* money nearby.
 */
const SALARY_CONTEXT_RE =
  /\b(salar(?:y|ies)|compensation|remuneration|\bctc\b|base pay|base salary|pay range|pay band|total rewards|package|per annum|annually|annual|takehome|take-home|pays?|paid|earn)\b/i;

function hasSalaryContext(text: string, index: number, matchLength: number): boolean {
  const before = text.slice(Math.max(0, index - 140), index);
  const after = text.slice(index + matchLength, index + matchLength + 60);
  return SALARY_CONTEXT_RE.test(before) || SALARY_CONTEXT_RE.test(after);
}

function scaleOf(unit: string | undefined): number {
  if (!unit) return 1;
  return UNIT_SCALE[unit.toLowerCase()] ?? 1;
}

/** Format whole rupees/dollars back into the compact form people actually read. */
function format(currency: Comp["currency"], min: number, max: number | null): string {
  const sym = SYMBOL[currency];
  const one = (n: number) => {
    if (currency === "INR") {
      if (n >= 10_000_000) return `${+(n / 10_000_000).toFixed(2)}Cr`;
      return `${+(n / 100_000).toFixed(n % 100_000 ? 1 : 0)}L`;
    }
    return `${Math.round(n / 1000)}k`;
  };
  return max && max !== min
    ? `${sym}${one(min)}–${one(max)}`
    : `${sym}${one(min)}`;
}

/**
 * Best-effort salary extraction. Returns null when nothing is stated, which is
 * the common case — treat it as "unknown", never as "pays badly".
 */
export function parseComp(description: string): Comp | null {
  if (!description) return null;
  // Salary is stated near words like "compensation"; scanning the whole JD
  // invites false positives from funding amounts and revenue figures.
  const text = description.slice(0, 20_000);

  const lpaRange = LPA_RANGE_RE.exec(text);
  if (lpaRange && !PER_UNIT_RE.test(around(text, lpaRange.index))) {
    const scale = scaleOf(lpaRange[3]);
    const min = toNumber(lpaRange[1], scale);
    const max = toNumber(lpaRange[2], scale);
    if (min && min >= ANNUAL_FLOOR.INR) return build("INR", min, max);
  }

  const range = RANGE_RE.exec(text);
  if (
    range &&
    !PER_UNIT_RE.test(around(text, range.index)) &&
    hasSalaryContext(text, range.index, range[0].length)
  ) {
    const currency = currencyOf(range[1]);
    const min = toNumber(range[2], scaleOf(range[3]));
    // "₹25L - 35L" states the unit twice; "₹25L - 35" states it once and means
    // the same thing. Inherit the first unit when the second is absent.
    const max = toNumber(range[5], range[6] ? scaleOf(range[6]) : scaleOf(range[3]));
    if (currency && min && min >= ANNUAL_FLOOR[currency])
      return build(currency, min, max);
  }

  const lpaSingle = LPA_SINGLE_RE.exec(text);
  if (lpaSingle && !PER_UNIT_RE.test(around(text, lpaSingle.index))) {
    const min = toNumber(lpaSingle[1], scaleOf(lpaSingle[2]));
    if (min && min >= ANNUAL_FLOOR.INR) return build("INR", min, null);
  }

  const single = SINGLE_RE.exec(text);
  if (
    single &&
    !PER_UNIT_RE.test(around(text, single.index)) &&
    hasSalaryContext(text, single.index, single[0].length)
  ) {
    const currency = currencyOf(single[1]);
    const min = toNumber(single[2], scaleOf(single[3]));
    if (currency && min && min >= ANNUAL_FLOOR[currency])
      return build(currency, min, null);
  }

  return null;
}

/** The 40 characters after a match, where "/hour" or "per month" would sit. */
function around(text: string, index: number): string {
  return text.slice(index, index + 80);
}

function build(currency: Comp["currency"], min: number, max: number | null): Comp {
  const hi = max && max > min ? max : null;
  return { currency, min, max: hi, label: format(currency, min, hi) };
}
