/**
 * Salary estimates for a company and role, from the sites people actually
 * report pay on: AmbitionBox, Glassdoor, Levels.fyi, 6figr, Indeed, Naukri.
 *
 * Most Indian postings state no pay, so this is the only way to answer "does it
 * clear the pay floor". It is crowd-sourced and often a sample of one, so every
 * figure comes back with its source and the sentence it was read from, and the
 * summary is a median across sources, never one site's number.
 *
 * Results are cached in ~/.jobscout/salaries.json (outside the repo) so a later
 * jobs_search can show the estimate next to the role without searching again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Searcher } from "./outreach";

export interface Figure {
  /** Lakhs per year. */
  low: number;
  high: number;
  source: string;
  url: string;
  /** The text the figure was read from, trimmed. */
  context: string;
  /** The words just before the figure, back to the previous separator: usually the title it belongs to. */
  label: string;
  /** Years of experience stated right after the figure ("17 years exp"), when there is one. */
  exp: number | null;
  /** Read from a full page rather than a search snippet. */
  page?: boolean;
  /** Set by lookupSalary: the figure is for the role asked about, so it counts toward the median. */
  relevant?: boolean;
}

export interface Estimate {
  company: string;
  role: string;
  at: string;
  /** Median of the per-source midpoints, lakhs per year. */
  medianLpa: number | null;
  lowLpa: number | null;
  highLpa: number | null;
  figures: Figure[];
}

const UNIT: Record<string, number> = { l: 1, lakh: 1, lakhs: 1, lac: 1, lacs: 1, lpa: 1, cr: 100, crore: 100 };
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
// The lookahead stops "₹20k" reading as ₹2 plus a unit, and "l" firing on "last".
const U = String.raw`(lpa|lakhs?|lacs?|l|cr|crore)?(?![a-z\d])`;
// "₹9.2 L/yr - ₹20 L/yr", "₹10.5 - 18L/yr", "₹17.0 to ₹25.0 lakhs", "INR 16 to 22 LPA"
const RANGE = new RegExp(
  String.raw`(?:₹|rs\.?|inr)\s*(${NUM})\s*${U}(?:\s*\/\s*yr)?\s*(?:-|–|to)\s*(?:₹|rs\.?|inr)?\s*(${NUM})\s*${U}`,
  "gi",
);
// "₹16,69,517", "₹23.3 LPA", "₹ 18,99,201"
const SINGLE = new RegExp(String.raw`(?:₹|rs\.?|inr)\s*(${NUM})\s*${U}`, "gi");
// "16 - 22 LPA" with no currency mark
const BARE = new RegExp(String.raw`(${NUM})\s*(?:-|–|to|and)\s*(${NUM})\s*(lpa|lakhs?|lacs?)\b`, "gi");

/** A number plus optional unit, to lakhs. Unitless full rupee amounts are divided down. */
function lakhs(raw: string, unit: string | undefined, fallbackUnit?: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (unit ?? fallbackUnit)?.toLowerCase();
  if (u && UNIT[u]) return n * UNIT[u];
  if (n >= 100_000) return n / 100_000;
  // "₹10.5 - 18" with no unit anywhere is almost always lakhs on these sites.
  return n < 500 ? n : null;
}

const plausible = (x: number | null): x is number => x !== null && x >= 1 && x <= 300;
const round = (x: number) => Math.round(x * 10) / 10;

/** Every pay figure in a piece of text, with the sentence around it. */
export function extractFigures(text: string, source: string, url: string): Figure[] {
  const out: Figure[] = [];
  const taken: [number, number][] = [];
  const ctx = (i: number, len: number) =>
    text.slice(Math.max(0, i - 90), i + len + 60).replace(/\s+/g, " ").trim();
  const push = (i: number, len: number, low: number | null, high: number | null) => {
    if (!plausible(low) || !plausible(high) || high < low) return;
    // Monthly figures ("₹85,000 per month") are not annual pay.
    if (/per month|\/\s*mo|monthly|in-hand/i.test(text.slice(i, i + len + 25))) return;
    taken.push([i, i + len]);
    const before = text.slice(Math.max(0, i - 120), i);
    // "Manager · ₹20L": the segment right before the figure is empty and the title sits one further back.
    // "₹14,30,000 for a Senior Analyst": the title follows the figure.
    const segs = before.split(/[;·|\n•]/).map((x) => x.trim()).filter((x) => x.length > 1);
    const forA = text.slice(i + len, i + len + 50).match(/^[^;.]*?\bfor an?\s+([^;.,]+)/i)?.[1] ?? "";
    const label = `${segs.pop() ?? ""} ${forA}`.trim();
    const exp = text.slice(i + len, i + len + 40).match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s*(?:of\s*)?exp/i);
    out.push({ low: round(low), high: round(high), source, url, context: ctx(i, len), label, exp: exp ? Number(exp[1]) : null });
  };
  const free = (i: number) => !taken.some(([a, b]) => i >= a && i < b);

  for (const m of text.matchAll(RANGE)) {
    const unit2 = m[4];
    push(m.index!, m[0].length, lakhs(m[1], m[2], unit2), lakhs(m[3], unit2, m[2]));
  }
  for (const m of text.matchAll(BARE)) {
    if (free(m.index!)) push(m.index!, m[0].length, lakhs(m[1], m[3]), lakhs(m[2], m[3]));
  }
  for (const m of text.matchAll(SINGLE)) {
    if (!free(m.index!)) continue;
    const v = lakhs(m[1], m[2]);
    push(m.index!, m[0].length, v, v);
  }
  return out;
}

function sourceOf(url: string): string {
  const h = url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  return (
    [["ambitionbox", "AmbitionBox"], ["glassdoor", "Glassdoor"], ["levels.fyi", "Levels.fyi"], ["6figr", "6figr"],
      ["indeed", "Indeed"], ["naukri", "Naukri"], ["weekday", "Weekday"], ["payscale", "PayScale"]] as const
  ).find(([k]) => h.includes(k))?.[1] ?? h;
}

/**
 * Titles that put a figure outside your band. The pages list every role at the
 * company side by side ("Senior Engineer ₹64-87L ; Manager ₹20-53L"), and one
 * CrowdStrike lookup averaged those into a ₹25.8L "software engineer" median.
 */
const OTHER_ROLE =
  /\b(senior|sr|staff|principal|lead|manager|director|architect|analyst|administrator|admin|consultant|iii|iv|head|vp|intern|fresher|accountant|hr|sales|support|qa|test|tester|marketing|recruiter|designer)\b/i;

/** Does this figure describe the role asked about, at roughly your experience? */
function isRelevant(f: Figure, role: string): boolean {
  if (f.exp !== null && f.exp > 6) return false;
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  // Page text runs every role's figures together with the titles stripped, so a
  // page figure counts only when its label names the role.
  if (f.page && !words(role).trim().split(" ").every((w) => words(f.label).includes(w))) return false;
  const asked = new Set(words(role).split(" "));
  // The label is the title when the snippet lists roles; the URL slug is the title on a role's own page.
  const slug = words(decodeURIComponent(f.url.replace(/^https?:\/\/[^/]+/, "")));
  for (const hay of [words(f.label), slug]) {
    const m = hay.match(new RegExp(OTHER_ROLE.source, "gi")) ?? [];
    if (m.some((w) => !asked.has(w.toLowerCase()))) return false;
  }
  return true;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/**
 * Search, read snippets, and optionally open the best AmbitionBox and
 * Levels.fyi pages for their full text. `read` returns a page's visible text.
 */
export async function lookupSalary(
  company: string,
  role: string,
  city: string | undefined,
  search: Searcher,
  read: ((url: string) => Promise<string>) | null,
): Promise<Estimate> {
  const c = `"${company}"`;
  const where = city ? ` ${city}` : " India";
  const queries = [
    `${c} ${role} salary site:ambitionbox.com`,
    `${c} ${role} salary${where} site:glassdoor.co.in`,
    `${c} software engineer salary${where} site:levels.fyi`,
    `${c} ${role} salary${where} LPA 6figr OR naukri OR indeed`,
  ];
  const figures: Figure[] = [];
  const pages = new Map<string, string>();
  const co = company.toLowerCase().split(/\s+/)[0];
  for (const q of queries) {
    const hits = await search(q, 8).catch(() => []);
    for (const h of hits) {
      // A page about another company with a similar name is worse than nothing.
      if (!`${h.title} ${h.url}`.toLowerCase().includes(co)) continue;
      const src = sourceOf(h.url);
      figures.push(...extractFigures(`${h.title}. ${h.snippet}`, src, h.url));
      if ((src === "AmbitionBox" || src === "Levels.fyi") && !pages.has(src) && /salar/i.test(h.url)) pages.set(src, h.url);
    }
  }
  if (read) {
    for (const [src, url] of pages) {
      const body = await read(url).catch(() => "");
      // Page text repeats the headline figure in nav and cards; keep the lines that read as pay statements.
      const lines = body.split("\n").filter((l) => /₹/.test(l) && /salar|ctc|l\/yr|lpa|compensation|median|average|range/i.test(l));
      figures.push(...extractFigures(lines.slice(0, 40).join("\n"), src, url).map((f) => ({ ...f, page: true })));
    }
  }
  // One figure per source and value: snippets and page text repeat each other.
  const seen = new Set<string>();
  const uniq = figures.filter((f) => {
    const k = `${f.source}|${f.low}|${f.high}`;
    return !seen.has(k) && seen.add(k);
  });
  for (const f of uniq) f.relevant = isRelevant(f, role);
  const counted = uniq.filter((f) => f.relevant);
  // Per source, the median midpoint, so a site that returned ten rows doesn't outvote one that returned two.
  const bySource = new Map<string, number[]>();
  for (const f of counted) bySource.set(f.source, [...(bySource.get(f.source) ?? []), (f.low + f.high) / 2]);
  const mids = [...bySource.values()].map((v) => median(v)!).filter(Boolean);
  const est: Estimate = {
    company,
    role,
    at: new Date().toISOString(),
    medianLpa: median(mids),
    lowLpa: counted.length ? Math.min(...counted.map((f) => f.low)) : null,
    highLpa: counted.length ? Math.max(...counted.map((f) => f.high)) : null,
    figures: uniq,
  };
  if (uniq.length) saveEstimate(est);
  return est;
}

// ---------------------------------------------------------------------------
// Cache

const FILE = join(homedir(), ".jobscout", "salaries.json");
const MAX_AGE_DAYS = 60;

function loadAll(): Record<string, Estimate> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

const key = (company: string) => company.toLowerCase().replace(/\s+(pvt|private|ltd|limited|inc|llp|india)\.?/g, "").trim();

function saveEstimate(e: Estimate): void {
  const all = loadAll();
  all[key(e.company)] = e;
  const dir = join(homedir(), ".jobscout");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

/** The cached median for a company, when it's recent enough to trust. */
export function cachedEstimate(company: string): number | null {
  const e = loadAll()[key(company)];
  if (!e?.medianLpa) return null;
  return Date.now() - new Date(e.at).getTime() < MAX_AGE_DAYS * 86_400_000 ? e.medianLpa : null;
}

export function formatEstimate(e: Estimate, floor: number | null): string {
  if (!e.figures.length) return `${e.company}: no pay figures found for "${e.role}". Ask the recruiter for the band.`;
  const counted = e.figures.filter((f) => f.relevant);
  const fmt = (f: Figure) => `${f.source} | ₹${f.low}${f.high !== f.low ? `-${f.high}` : ""}L | ${f.context.slice(0, 170)} | ${f.url}`;
  const others = e.figures.filter((f) => !f.relevant);
  const tail = others.length ? [`other roles or 7+ yrs, not counted (${others.length}):`, ...others.slice(0, 5).map(fmt)] : [];
  if (!counted.length) return [`${e.company}: no figures for "${e.role}" itself; only other roles.`, ...tail].join("\n");
  const head =
    `${e.company} · ${e.role}: median ₹${e.medianLpa}L from ${counted.length} figures across ${new Set(counted.map((f) => f.source)).size} sources, ` +
    `spread ₹${e.lowLpa}L to ₹${e.highLpa}L` +
    (floor ? ` · ${e.medianLpa! >= floor ? "clears" : "below"} the ₹${floor}L floor` : "");
  return [head, "Crowd-sourced; check the role and years in each line before trusting it.", "source | figure | context | url", ...counted.slice(0, 12).map(fmt), ...tail].join("\n");
}
