import type { Application } from "@/db/schema";
import { daysSince } from "./time";

/**
 * Turns the tracker into an answer to "why am I not hearing back?".
 *
 * Everything here is derived from two timestamps — when you applied and when
 * anyone first replied. Slicing the reply rate by eligibility, posting age and
 * source is what tells you whether the board's assumptions are actually right,
 * instead of us guessing.
 */

/** Silence past this many days is a non-answer, not a pending decision. */
export const GHOST_AFTER_DAYS = 21;

export function hasReplied(a: Application): boolean {
  return a.firstResponseAt !== null;
}

export function isGhosted(a: Application): boolean {
  if (!a.appliedAt || a.firstResponseAt) return false;
  const d = daysSince(a.appliedAt);
  return d !== null && d >= GHOST_AFTER_DAYS;
}

/** Applied, no reply yet, still inside the window where silence is normal. */
export function isWaiting(a: Application): boolean {
  if (!a.appliedAt || a.firstResponseAt) return false;
  const d = daysSince(a.appliedAt);
  return d !== null && d < GHOST_AFTER_DAYS;
}

/** Days from sending the application to the first reply of any kind. */
export function daysToReply(a: Application): number | null {
  if (!a.appliedAt || !a.firstResponseAt) return null;
  const from = new Date(a.appliedAt).getTime();
  const to = new Date(a.firstResponseAt).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** How old the posting was on the day you applied to it. */
export function ageAtApplication(a: Application): number | null {
  if (!a.postedAt || !a.appliedAt) return null;
  const posted = new Date(a.postedAt).getTime();
  const applied = new Date(a.appliedAt).getTime();
  if (Number.isNaN(posted) || Number.isNaN(applied)) return null;
  return Math.max(0, Math.floor((applied - posted) / 86_400_000));
}

export function freshnessBucket(a: Application): string {
  const d = ageAtApplication(a);
  if (d === null) return "unknown age";
  if (d <= 3) return "applied within 3d";
  if (d <= 7) return "applied within 1wk";
  if (d <= 30) return "applied within 1mo";
  return "applied after 1mo+";
}

export interface Funnel {
  tracked: number;
  applied: number;
  replied: number;
  interviewing: number;
  offers: number;
  ghosted: number;
  waiting: number;
  /** Share of applications that got any reply at all. Null until you apply. */
  replyRate: number | null;
  /** Median days from applying to first reply, across replies received. */
  medianDaysToReply: number | null;
}

export function buildFunnel(apps: Application[]): Funnel {
  const applied = apps.filter((a) => a.appliedAt !== null);
  const replied = applied.filter(hasReplied);

  const gaps = replied
    .map(daysToReply)
    .filter((d): d is number => d !== null)
    .sort((x, y) => x - y);

  return {
    tracked: apps.length,
    applied: applied.length,
    replied: replied.length,
    interviewing: apps.filter((a) => a.status === "interviewing").length,
    offers: apps.filter((a) => a.status === "offer").length,
    ghosted: applied.filter(isGhosted).length,
    waiting: applied.filter(isWaiting).length,
    replyRate: applied.length ? replied.length / applied.length : null,
    medianDaysToReply: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
  };
}

export interface Slice {
  label: string;
  applied: number;
  replied: number;
  rate: number | null;
}

/**
 * Reply rate grouped by some property of the application. Only applications you
 * actually sent are counted — saved-but-never-applied rows would dilute it.
 */
export function sliceBy(
  apps: Application[],
  key: (a: Application) => string,
): Slice[] {
  const groups = new Map<string, { applied: number; replied: number }>();

  for (const a of apps) {
    if (!a.appliedAt) continue;
    const label = key(a);
    const g = groups.get(label) ?? { applied: 0, replied: 0 };
    g.applied += 1;
    if (hasReplied(a)) g.replied += 1;
    groups.set(label, g);
  }

  return [...groups.entries()]
    .map(([label, g]) => ({
      label,
      applied: g.applied,
      replied: g.replied,
      rate: g.applied ? g.replied / g.applied : null,
    }))
    .sort((a, b) => b.applied - a.applied);
}

export const pct = (v: number | null) =>
  v === null ? "—" : `${Math.round(v * 100)}%`;

/**
 * What your dismissals say about the ranking.
 *
 * This is the only supervised signal the app gets, and it points at scoring
 * rather than at reply rates: a dismissal is you telling the board it was wrong
 * about a role, and `reason` says which weight in profile.ts was wrong. The
 * score at dismissal time is what makes it actionable. Ruling out something the
 * board had already put at 30 is agreement; ruling out something it put at 95 is
 * a bug with a location.
 */
export interface DismissalSlice {
  reason: string;
  count: number;
  /** Mean fit score of the roles you ruled out for this reason. */
  avgScore: number;
  /** The worst disagreement in this group: highest-scoring role you rejected. */
  topScore: number;
}

export function summarizeDismissals(
  rows: { reason: string; score: number }[],
): DismissalSlice[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const list = groups.get(r.reason) ?? [];
    list.push(r.score);
    groups.set(r.reason, list);
  }

  return [...groups.entries()]
    .map(([reason, scores]) => ({
      reason,
      count: scores.length,
      avgScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      topScore: Math.max(...scores),
    }))
    // Highest disagreement first: the group whose roles were ranked best is the
    // one whose weights are most worth editing.
    .sort((a, b) => b.topScore - a.topScore || b.count - a.count);
}

/** The lever in profile.ts each dismissal reason points at. */
export const DISMISS_LEVER: Record<string, string> = {
  stack: "profile.offStackTech / techKeywords",
  level: "profile.seniority / yoeGap",
  domain: "profile.offStackDomains",
  location: "profile.basedIn, lib/regions.ts",
  pay: "lib/comp.ts (unscored by design)",
  company: "not a scoring signal",
  other: "unclassified",
};
