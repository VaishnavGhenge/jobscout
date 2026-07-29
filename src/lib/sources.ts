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
