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
  /**
   * Moved with the scale rather than kept. Eligibility (25 points) left the
   * score entirely and freshness dropped from ±25 to ±6, so the same role now
   * scores roughly 25 lower and 45 would have let the off-level band back on.
   *
   * 50 is where "matches a role you'd take, nothing disqualifying" lands: base
   * 44 plus a role match. Set it higher and roles titled plainly ("Software
   * Engineer", "Golang Developer") fall off the default board, which was the
   * first thing 55 did.
   */
  minScore: "50",
  elig: "open",
  sort: "score",
} as const;

/** Tracker equivalent. "updated" = the order the query already returns. */
export const TRACKER_DEFAULTS = {
  sort: "updated",
} as const;
