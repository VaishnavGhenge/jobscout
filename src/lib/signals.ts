import { profile } from "./profile";

/**
 * Signals about your odds on a role that aren't about fit: how crowded it is,
 * how you'd apply, and what notice it wants. Used by the MCP searches on top
 * of the fit score; the board and the watcher don't use them.
 */
export interface Signal {
  points: number;
  label: string | null;
}

const NONE: Signal = { points: 0, label: null };

/** "Over 200 applicants" -> 200, "Be among the first 25 applicants" -> 24, "140 applicants" -> 140. */
export function applicantCount(s: string | null | undefined): number | null {
  if (!s) return null;
  if (/first\s+(\d+)/i.test(s)) return Number(s.match(/first\s+(\d+)/i)![1]) - 1;
  const n = s.match(/(\d[\d,]*)/)?.[1];
  return n ? Number(n.replace(/,/g, "")) : null;
}

const UNIT_H: Record<string, number> = { minute: 1 / 60, m: 1 / 60, hour: 1, h: 1, day: 24, d: 24, week: 168, w: 168, month: 720, mo: 720 };

/** "21 minutes ago", "3 hours ago", "26m", "4h", "1d" -> hours. */
export function ageHours(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d+)\s*(minute|hour|day|week|month)s?\b/i) ?? s.trim().match(/^(\d+)\s*(mo|[mhdw])$/i);
  if (!m) return /just now/i.test(s) ? 0 : null;
  return Number(m[1]) * UNIT_H[m[2].toLowerCase()];
}

/**
 * Crowding: applicant count and age. A role under a day old with 30 applicants
 * is a better use of an application than a closer title match at 200+, where
 * the first screen is a resume pile.
 */
export function competition(applicants: string | null | undefined, posted: string | null | undefined): Signal {
  const c = profile.competition;
  let points = 0;
  const labels: string[] = [];
  const n = applicantCount(applicants);
  if (n !== null) {
    const tier = c.applicants.find((t) => n <= t.max) ?? c.applicants[c.applicants.length - 1];
    points += tier.points;
    if (tier.label) labels.push(tier.label);
  }
  const h = ageHours(posted);
  if (h !== null && h <= c.fresh.hours) {
    points += c.fresh.points;
    labels.push(c.fresh.label);
  }
  return labels.length || points ? { points, label: labels.join(", ") } : NONE;
}

/** How you'd apply, from a post's apply route. Direct routes reach a person; "none" means hunting for one. */
export function applyRoute(kind: keyof typeof profile.applyRoute): Signal {
  const points = profile.applyRoute[kind] ?? 0;
  return points ? { points, label: `apply via ${kind}` } : NONE;
}

/**
 * The notice the employer wants, when the text says. Flagged, never scored or
 * dropped: whether a 30-day notice gets through these is the open question,
 * so they stay visible.
 */
export interface NoticeAsk {
  /** Most days they'll wait. 0 for "immediate". */
  days: number;
  /** Fewer days than the notice you state (NOTICE_DAYS in .env). */
  short: boolean;
  label: string;
}

const NOTICE: { re: RegExp; days: (m: RegExpMatchArray) => number }[] = [
  // "Immediate to 15 days", "immediate - 30 days joiners"
  { re: /immediate\s*(?:to|-|–|\/)\s*(\d{1,3})\s*days/i, days: (m) => Number(m[1]) },
  { re: /\b(?:immediate(?:ly)?\s*(?:joiners?|joining|join|available|starters?)|join(?:ing)?\s+immediately|currently serving notice|serving notice)/i, days: () => 0 },
  // "Notice period: max 30 days", "NP: 15 days", "notice period of less than 30 days"
  { re: /\b(?:notice\s*period|np)\s*[:\-–]?\s*(?:of\s*)?(?:max(?:imum)?\.?\s*|up\s*to\s*|less than\s*|<\s*=?\s*|within\s*|upto\s*)?(\d{1,3})\s*days/i, days: (m) => Number(m[1]) },
  // "join within 15 days"
  { re: /\b(?:join(?:ing)?|start)\s+within\s+(\d{1,3})\s*days/i, days: (m) => Number(m[1]) },
  // "15 days notice", "30 days NP"
  { re: /\b(\d{1,3})\s*days?\s*(?:notice|np)\b/i, days: (m) => Number(m[1]) },
];

/** The notice you state on applications. In .env, not profile.ts: the repo is public. */
export function noticeDays(): number {
  const n = Number(process.env.NOTICE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export function noticeAsk(text: string): NoticeAsk | null {
  for (const { re, days } of NOTICE) {
    const m = text.match(re);
    if (!m) continue;
    const d = days(m);
    if (!Number.isFinite(d) || d > 180) continue;
    const short = d < noticeDays();
    return { days: d, short, label: d === 0 ? "wants immediate joiner" : `wants ≤${d}d notice` };
  }
  return null;
}
