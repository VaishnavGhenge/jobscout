import type { ApplicationChannel } from "@/db/schema";

/**
 * Where an application came from when it wasn't scraped.
 *
 * `applications.source` is free-form text — the ATS connectors write their own
 * name into it ("greenhouse", "lever", …), and hand-added rows write one of
 * these. Keeping them in the same column is the point: /insights slices reply
 * rate by source, so "wellfound" sits next to "greenhouse" and you can see
 * which one actually answers you.
 */
export const MANUAL_SOURCES = [
  "linkedin",
  "wellfound",
  "referral",
  "company site",
  "other",
] as const;

export type ManualSource = (typeof MANUAL_SOURCES)[number];

/** True for rows you added by hand, false for anything a connector produced. */
export function isManualSource(source: string): source is ManualSource {
  return (MANUAL_SOURCES as readonly string[]).includes(source);
}

/**
 * How an application reached the company, in the order the add form offers
 * them. The HR form comes first because it's the channel that has actually
 * produced shortlists, so it's the one you'll log most.
 */
export const CHANNELS: { key: ApplicationChannel; label: string; short: string }[] = [
  { key: "hr_form", label: "HR form (from a recruiter's post)", short: "HR form" },
  { key: "recruiter_direct", label: "Direct to HR / recruiter (DM, email)", short: "direct to HR" },
  { key: "referral", label: "Referral", short: "referral" },
  { key: "quick_apply", label: "Quick apply (Easy Apply, Naukri)", short: "quick apply" },
  { key: "ats", label: "Company job board / careers page", short: "ATS" },
  { key: "other", label: "Other", short: "other" },
];

export function channelLabel(channel: string): string {
  return CHANNELS.find((c) => c.key === channel)?.short ?? channel;
}

export function isChannel(v: string): v is ApplicationChannel {
  return CHANNELS.some((c) => c.key === v);
}
