/**
 * Bands for the score ring. Moved down with the scale: eligibility and freshness
 * used to contribute 50 of the 100 points and now contribute 0 and at most 6, so
 * the same role scores roughly 25 lower than it did. A fully aligned role tops
 * out near 98, a target-level role with your stack in the title sits around 90,
 * and a bare "Software Engineer" with nothing else known lands in the 50s.
 */
export function scoreClass(s: number) {
  return s >= 78 ? "high" : s >= 58 ? "mid" : "low";
}
