import type { Region } from "./regions";

/**
 * Your search profile. Everything about scoring/relevance is driven from here —
 * edit this file to re-tune the whole board. No code changes needed.
 *
 * The scoring model answers "is this worth an application?", which is not the
 * same question as "does this title look like me". Two factors dominate and are
 * weighted accordingly: can you actually be hired for it (eligibility), and is
 * the req still live (freshness). Title matching is a tiebreaker, not the point.
 */
export const profile = {
  /** Where you are and can work without sponsorship. Drives eligibility. */
  basedIn: "india" as Region,

  /**
   * Extra regions you could take a role in without needing a new visa. Leave
   * empty unless you genuinely hold work rights there — every entry here widens
   * the board with roles that will screen you out on question one.
   */
  alsoEligibleIn: [] as Region[],

  // Titles that signal a role you'd actually take. Modest positive — nearly
  // every engineering posting contains one of these, so it can't carry weight.
  roleKeywords: [
    "backend",
    "back-end",
    "back end",
    "full stack",
    "fullstack",
    "full-stack",
    "software engineer",
    "software development engineer",
    "platform engineer",
    "application engineer",
    "product engineer",
    "sde",
  ],

  // Your stack. Matched against the title and the description.
  techKeywords: [
    "python",
    "django",
    "fastapi",
    "go",
    "golang",
    "typescript",
    "node",
    "react",
    "postgres",
    "graphql",
  ],

  // Level you're targeting (SDE-2 / mid). Positive when present.
  // Matched on word boundaries, so "ii" hits "Engineer II" but not "VIII".
  seniorityPreferred: [
    "ii",
    "2",
    "mid",
    "mid-level",
    "sde 2",
    "sde-2",
    "sde ii",
    "intermediate",
  ],

  // Levels that aren't your target right now. Strong negative.
  // Also word-boundary matched — "lead" has to catch "Lead, Engineering" and
  // "Lead Engineer" without firing on "leadership" or "leading".
  seniorityAvoid: [
    "intern",
    "internship",
    "graduate",
    "new grad",
    "principal",
    "staff",
    "director",
    "vp",
    "head of",
    "manager",
    "lead",
    "architect",
    "fellow",
  ],

  /**
   * Description phrases that mean you'd be auto-rejected on the eligibility
   * question no matter how good the fit is. This is the single highest-value
   * filter in the app — these sentences are why cold applications vanish.
   */
  blockPhrases: [
    "must be authorized to work in the united states",
    "must be legally authorized to work in the u.s",
    "authorized to work in the us without sponsorship",
    "we are unable to sponsor",
    "we do not sponsor",
    "not able to sponsor",
    "no visa sponsorship",
    "without visa sponsorship",
    "sponsorship is not available",
    "unable to provide visa sponsorship",
    "must reside in the united states",
    "must be located in the united states",
    "u.s. citizen",
    "us citizenship",
    "security clearance",
    "must be based in the us",
  ],

  /**
   * Freshness tiers, applied to the posting date. A req open for months is
   * usually filled, frozen, or buried under a thousand applicants — applying on
   * day 2 beats a perfect title match on day 80.
   */
  freshness: [
    { maxDays: 3, points: 25, label: "posted <3d" },
    { maxDays: 7, points: 20, label: "posted this week" },
    { maxDays: 14, points: 12, label: "posted <2wk" },
    { maxDays: 30, points: 4, label: "posted <1mo" },
    { maxDays: 60, points: -8, label: "aging (1-2mo)" },
    { maxDays: 90, points: -18, label: "stale (2-3mo)" },
    { maxDays: Infinity, points: -30, label: "stale (3mo+)" },
  ],

  /** Scoring weights. Tune these to change how the board ranks. */
  weights: {
    base: 30,
    roleMatch: 12,
    levelMatch: 12,
    levelAvoid: -40,
    techMatch: 6,
    eligible: 25,
    longshot: -10,
    /** Blocked roles can never score above this, so they sink regardless. */
    blockedCap: 15,
    /** No posting date at all — mild penalty, we can't verify it's live. */
    unknownAge: -5,
  },

  /**
   * Titles that contain "engineer" but aren't software engineering jobs. These
   * are customer-facing and sales roles; without this list they sail through
   * the gate and clutter the top of the board.
   */
  titleExclusions: [
    "customer engineer",
    "solutions engineer",
    "solution engineer",
    "sales engineer",
    "field engineer",
    "presales",
    "pre-sales",
    "solutions architect",
    "solution architect",
    "technical account",
    "engineering manager",
    "director of engineering",
    "recruiter",
    "sourcer",
  ],

  // Titles kept in the DB at all. Anything not matching these is dropped on
  // refresh so the board stays engineering-only (no sales/marketing/CS noise).
  engineeringGate: [
    "engineer",
    "developer",
    "sde",
    "backend",
    "back-end",
    "back end",
    "frontend",
    "front-end",
    "full stack",
    "fullstack",
    "full-stack",
    "software",
    "platform",
    "infrastructure",
    "sre",
    "devops",
    "programmer",
  ],
} as const;

/** Every region you can be hired in without new work authorization. */
export const eligibleRegions: Region[] = [
  profile.basedIn,
  ...profile.alsoEligibleIn,
];
