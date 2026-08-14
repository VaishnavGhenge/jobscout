/**
 * Default values for the board and tracker filter bars, so "is a filter active?",
 * "what does Clear reset to?" and the server's own query agree on what normal is.
 *
 * These live outside the `"use client"` components that render them for a
 * non-obvious reason: when a server component imports from a client module, the
 * import resolves to a client *reference*, not the value. `FILTER_DEFAULTS.minScore`
 * read on the server came back undefined, which quietly dropped the board's
 * 45-point score floor and left both selects with no option marked selected.
 */
export const FILTER_DEFAULTS = {
  minScore: "45",
  elig: "open",
  sort: "score",
} as const;

/** Tracker equivalent. "updated" = the order the query already returns. */
export const TRACKER_DEFAULTS = {
  sort: "updated",
} as const;
