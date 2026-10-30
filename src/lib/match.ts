/**
 * Term matching for job titles and descriptions.
 *
 * Every keyword list in profile.ts is matched through here. It exists because
 * the two obvious approaches are both wrong in ways that quietly corrupt the
 * board:
 *
 * - Plain `includes` is far too loose. "go" is inside "Django", "Mongo",
 *   "algorithm", "goals" and "Bangalore", so a substring test reported a Go
 *   stack match on roles that never mention Go. Half the "stack in JD" badges on
 *   the board were this.
 * - A bare `\bterm\b` is too strict at the edges. `\blead\b` does not match
 *   "Leader", so "Technical Leader" and "Team Leader" skipped the off-level
 *   penalty entirely while "Tech Lead" took it. It also can't express ".net" or
 *   "c#" at all: `\b` before a dot or after a hash means the opposite of what
 *   you want.
 *
 * So: alphanumeric edges of a term get a "not part of a longer word" guard, and
 * non-alphanumeric edges (".net", "c#", "c++") get none, because there is no
 * word boundary there to assert.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The two guards are deliberately not the same set.
 *
 * A dot counts as part of the name on the *left* ("net" must not match inside
 * "ASP.NET") but not on the *right*, because a trailing dot is how half these
 * names are spelled in the wild: "Node.js", "React.js", "Next.js". Including it
 * in both guards was the version that silently matched neither.
 *
 * `+` and `#` are in both, so "c" can't match the C of "C++" or "C#".
 */
const LEFT = "a-z0-9+#.";
const RIGHT = "a-z0-9+#";

/**
 * Terms that are also ordinary English words, and the pattern that separates the
 * technology from the word.
 *
 * Word-boundary matching is exactly right for "Django" and not enough for "go":
 * "we go beyond the job description", "assess what it takes to go live" and
 * "clear go-to-market value propositions" are all term matches and none of them
 * is the language. That was 1074 rows claiming a Go match, most of them prose.
 *
 * Case is the discriminator, so these are matched against the original text
 * rather than a lowercased copy. The language is written "Go" or "Golang"; the
 * verb is lowercase everywhere except a sentence start, which is vanishingly
 * rare in a requirements list. The trailing guard also rejects the hyphen, since
 * "Go-To-Market" gets capitalised in headings.
 */
const AMBIGUOUS: Record<string, RegExp> = {
  go: /(?<![a-zA-Z0-9+#.])Go(?![a-zA-Z0-9+#-])/,
};

const cache = new Map<string, RegExp>();

function termRe(term: string): RegExp {
  const hit = cache.get(term);
  if (hit) return hit;

  const ambiguous = AMBIGUOUS[term];
  if (ambiguous) {
    cache.set(term, ambiguous);
    return ambiguous;
  }

  const startsAlnum = /^[a-z0-9]/i.test(term);
  const endsAlnum = /[a-z0-9]$/i.test(term);
  const re = new RegExp(
    `${startsAlnum ? `(?<![${LEFT}])` : ""}${escapeRe(term)}${
      endsAlnum ? `(?![${RIGHT}])` : ""
    }`,
    "i",
  );
  cache.set(term, re);
  return re;
}

/**
 * Does `haystack` contain `term` as a term rather than as a fragment?
 *
 * Pass the text with its original casing. Matching is case-insensitive for
 * everything except the entries in `AMBIGUOUS`, which need the case to tell a
 * technology from an English word.
 */
export function matchesTerm(haystack: string, term: string): boolean {
  return termRe(term).test(haystack);
}

/** Every term in `terms` that appears in `haystack`, in list order. */
export function matchTerms(
  haystack: string,
  terms: readonly string[],
): string[] {
  if (!haystack) return [];
  return terms.filter((t) => termRe(t).test(haystack));
}

/**
 * Substring variant, for lists whose entries deliberately carry surrounding
 * whitespace to control their own boundaries (see `titleExclusions`, where
 * " it systems" has a load-bearing leading space). Kept separate and named so
 * the difference is a decision rather than an accident.
 */
export function includesAny(
  haystack: string,
  needles: readonly string[],
): string[] {
  return needles.filter((n) => haystack.includes(n));
}
