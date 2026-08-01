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

  /**
   * Your level, as a band rather than a single target — you'd take SDE-1 or
   * SDE-2, a Senior req is a stretch worth seeing but not worth ranking first,
   * and anything above that is a waste of an application at 2 YOE.
   *
   * All three lists are matched on word boundaries against the *title*, so "ii"
   * hits "Engineer II" but not "VIII", and "lead" catches "Lead Engineer"
   * without firing on "leadership".
   */
  seniority: {
    /** Squarely your band. */
    target: [
      "i",
      "1",
      "sde 1",
      "sde-1",
      "sde i",
      "ii",
      "2",
      "sde 2",
      "sde-2",
      "sde ii",
      "mid",
      "mid-level",
      "intermediate",
      "associate",
    ],
    /**
     * Reachable on a good day, but most "Senior" reqs in this market want 5+
     * years. Penalized enough to sit below your own band, not enough to vanish
     * — some companies grade Senior at 3-4 years and those are worth seeing.
     */
    stretch: ["senior", "sr", "iii", "3"],
    /** Not happening at 2 YOE, or not an IC role at all. */
    avoid: [
      "intern",
      "internship",
      "graduate",
      "new grad",
      "principal",
      "staff",
      "distinguished",
      "director",
      "vp",
      "head of",
      "manager",
      "lead",
      "architect",
      "fellow",
      "iv",
      "v",
    ],
  },

  /**
   * Adjacent engineering disciplines. Not your stack, but close enough that the
   * title sails through every other filter — "Senior Software Engineer - Mobile
   * (Android)" scores identically to a backend role without this. Ranked down
   * rather than dropped, so they're still there if you want to browse them.
   */
  offStackDomains: [
    "android",
    "ios",
    "mobile",
    "react native",
    "flutter",
    "swift",
    "kotlin",
    "embedded",
    "firmware",
    "hardware",
    "machine learning",
    "data scientist",
    "data science",
    "data engineer",
    "analytics engineer",
    "computer vision",
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
    /** Senior: still shown, but never above a role in your own band. */
    levelStretch: -12,
    levelAvoid: -40,
    techMatch: 6,
    /** Adjacent discipline (mobile, ML, data) — a real role, just not yours. */
    offStack: -15,
    eligible: 25,
    longshot: -10,
    /** Blocked roles can never score above this, so they sink regardless. */
    blockedCap: 15,
    /** No posting date at all — mild penalty, we can't verify it's live. */
    unknownAge: -5,
  },

  /**
   * Titles that contain "engineer" but aren't software engineering jobs. These
   * are customer-facing, sales, QA and IT roles; without this list they sail
   * through the gate and clutter the top of the board. Dropped on refresh, not
   * merely ranked down — they were never applications you'd send.
   */
  titleExclusions: [
    // Sales / pre-sales / customer-facing
    "customer engineer",
    "solutions engineer",
    "solution engineer",
    "sales engineer",
    "inside sales",
    "field engineer",
    "presales",
    "pre-sales",
    "solutions architect",
    "solution architect",
    "solutions consultant",
    "technical account",
    "technical services",
    "demo engineer",
    "escalation engineer",
    "support engineer",
    "support specialist",
    "designated support",
    "implementation engineer",
    "implementation consultant",
    "implementation specialist",
    "professional services",
    "business solutions",
    "customer success",
    "forward deployed",
    "developer advocate",
    "developer relations",
    "developer content",
    "gtm",

    // QA / test — a separate discipline and career track
    "qa engineer",
    "quality engineer",
    "quality assurance",
    "test engineer",
    "engineer in test",
    "sdet",
    "automation engineer",

    // Business systems dressed up as engineering
    "salesforce",
    "workday",
    "netsuite",
    "sap ",
    "business intelligence",
    "business systems",
    "information systems",
    "bus sys",
    "bizops",
    "biztech",

    /**
     * Internal IT and support desks. Deliberately *not* a bare "systems
     * engineer": at infra companies that title is a real backend role, and
     * "Distributed Systems Engineer" is squarely on-stack. Only the qualified
     * forms are excluded.
     *
     * The leading spaces are load-bearing. These are substring-matched (see
     * isEngineeringRole), and "it systems" without one also fires on
     * "Credit Systems Engineer" — the same trap the "ios"/"kiosk" comment in
     * scoring.ts describes.
     */
    " it systems",
    " it operations",
    " it support",
    "service desk",
    "helpdesk",
    "desktop support",

    // Security operations (not product/appsec engineering)
    "incident response",
    "threat intelligence",
    "security operations",
    "soc analyst",

    // Management / non-IC / not a job posting at all
    "engineering manager",
    "director of engineering",
    "product manager",
    "program manager",
    "developer marketing",
    "operations analyst",
    "recruiter",
    "sourcer",
    /** Evergreen "join our talent pool" listings — no req behind them. */
    "talent community",
    "talent pool",
    "general application",
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
