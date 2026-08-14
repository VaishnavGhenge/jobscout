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
