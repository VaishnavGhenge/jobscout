/** Whole days elapsed since `date`, or null when there's no date to go on. */
export function daysSince(date: Date | string | null | undefined): number | null {
  if (!date) return null;
  const then = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86_400_000));
}

/** Compact age for a posting, e.g. "new", "6d old", "3mo old". */
export function ageLabel(date: Date | string | null | undefined): string {
  const d = daysSince(date);
  if (d === null) return "no date";
  if (d === 0) return "new today";
  if (d === 1) return "1d old";
  if (d < 30) return `${d}d old`;
  const months = Math.floor(d / 30);
  return `${months}mo old`;
}

/** Compact relative time, e.g. "just now", "12m ago", "3h ago", "2d ago". */
export function timeAgo(date: Date | string | null): string {
  if (!date) return "never";
  const then = typeof date === "string" ? new Date(date) : date;
  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
