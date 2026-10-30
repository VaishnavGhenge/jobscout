import type { Region } from "./regions";

/**
 * Your search profile. Everything about scoring/relevance is driven from here:
 * edit this file, then hit Rescore on the board to see the effect. No refetch,
 * no code changes.
 *
 * The scoring model answers "is this worth an application?", which is not the
 * same question as "does this title look like me".
 *
 * What it does *not* score, and why, matters as much as what it does:
 *
 * - Eligibility is a filter, not points. It used to be worth 25 of the 100, but
 *   98% of the roles you actually browse are already eligible (the board hides
 *   the rest by default), so those 25 points were a constant dressed up as a
 *   signal. It buys nothing and it crowds out the factors that do vary.
 * - Freshness is applied at read time, never stored. See lib/freshness.ts: a
 *   score baked at fetch time keeps claiming "posted <3d" for weeks afterwards,
 *   which is exactly what it did to 553 rows before this was moved.
 *
 * What is left in the stored score is the part that genuinely doesn't change
 * while the row sits there: level, stack, discipline and the experience ask.
 */
export const profile = {
  /** Where you are and can work without sponsorship. Drives eligibility. */
  basedIn: "india" as Region,

  /**
   * Extra regions you could take a role in without needing a new visa. Leave
   * empty unless you genuinely hold work rights there: every entry here widens
   * the board with roles that will screen you out on question one.
   */
  alsoEligibleIn: [] as Region[],

  /**
   * Your years of experience. Scored against what the posting asks for, so this
   * has to be honest: raise it and the whole board's level judgement moves with
   * it.
   */
  yearsExperience: 2,

  // Titles that signal a role you'd actually take. Modest positive: nearly
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

  /**
   * Your stack. Matched against the title and the description.
   *
   * Every entry is matched as a *term*, not a substring (see lib/match.ts).
   * That distinction was worth roughly a third of the board's stack badges:
   * "go" as a substring fires on Django, Mongo, algorithm, goals and going, so
   * a large share of "stack in JD: go" was reporting a Go match on roles that
   * never mentioned Go.
   *
   * Spelling variants need their own entry where a suffix runs into the name.
   * "React.js" matches "react", but "ReactJS" does not.
   */
  techKeywords: [
    "python",
    "django",
    "fastapi",
    "flask",
    "go",
    "golang",
    "typescript",
    "javascript",
    "node",
    "nodejs",
    "node.js",
    "react",
    "reactjs",
    "react.js",
    "next.js",
    "nextjs",
    "postgres",
    "postgresql",
    "graphql",
    "redis",
    "kubernetes",
    "grpc",
  ],

  /**
   * Stacks you don't work in, named in the title.
   *
   * This is the counterweight `techKeywords` was missing. On-stack terms only
   * ever added points, so ".NET Full Stack Developer" and "Full stack (Python)
   * Developer" scored identically, and a C#/Angular role at UPS sat at 100 on a
   * board where it was the single role you had explicitly dismissed.
   *
   * Matched against the title only. A JD that mentions Java somewhere is normal;
   * a title that leads with it is telling you what the job is.
   *
   * These are ranked down, not dropped: a mixed-stack role ("C#, React") lands
   * below a clean one rather than vanishing.
   */
  offStackTech: [
    // .NET and the Microsoft application stack
    ".net",
    "dotnet",
    "asp.net",
    "vb.net",
    "c#",
    "mvc",
    "wpf",
    "winforms",
    "xamarin",
    "blazor",
    // Java
    "java",
    "j2ee",
    "jsp",
    "spring boot",
    "spring mvc",
    "hibernate",
    "struts",
    // Front-end frameworks that aren't yours
    "angular",
    "angularjs",
    "jquery",
    "ember",
    "backbone",
    // PHP and CMS work
    "php",
    "laravel",
    "symfony",
    "codeigniter",
    "drupal",
    "wordpress",
    "magento",
    // Other languages
    "ruby",
    "rails",
    "ruby on rails",
    "scala",
    "perl",
    "c++",
    "objective-c",
    "delphi",
    "matlab",
    // Data platform and ETL tooling. In a *title* these mean data engineering,
    // whatever the title also says about software.
    "etl",
    "pyspark",
    "spark",
    "hadoop",
    "hive",
    "informatica",
    "talend",
    "datastage",
    "ab initio",
    "snowflake",
    "databricks",
    "tableau",
    "qlik",
    "power bi",
    "powerbi",
    "ssis",
    "ssrs",
    "ssas",
    "cognos",
    "microstrategy",
    // Test tooling. The QA *titles* are excluded outright; this catches a
    // software-engineer title that turns out to be automation work.
    "selenium",
    "appium",
    "jmeter",
    "loadrunner",
    "qtp",
    // Enterprise platforms
    "pega",
    "sharepoint",
    "biztalk",
    "tibco",
    "mulesoft",
    "boomi",
  ],

  /**
   * Your level, as a band rather than a single target: you'd take SDE-1 or
   * SDE-2, a Senior req is a stretch worth seeing but not worth ranking first,
   * and anything above that is a waste of an application at 2 YOE.
   *
   * All three lists are matched as terms against the *title*, so "ii" hits
   * "Engineer II" but not "VIII".
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
      "junior",
      "jr",
    ],
    /**
     * Reachable on a good day, but most "Senior" reqs in this market want 5+
     * years. Penalized enough to sit below your own band, not enough to vanish:
     * some companies grade Senior at 3-4 years and those are worth seeing.
     *
     * "Associate" sits here rather than in `target` because the word means two
     * opposite things. At an Indian services firm it's an entry grade; at
     * Goldman, JPMorgan or Bain it's a rank above analyst at roughly 3-6 years.
     * Three of those banking "Associate" reqs were scoring 100.
     */
    stretch: ["senior", "sr", "iii", "3", "associate"],
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
      "vice president",
      "head of",
      "manager",
      "lead",
      /**
       * "leader" is here in its own right because `lead` cannot reach it.
       * Matching is term-based, so `lead` correctly ignores "leadership" and
       * just as correctly ignores "Leader": Cisco's "Software Engineering
       * Technical Leader (12-15 Years)" and "Leader, Software Engineering (10
       * years)" both scored 98 on that gap, while plain "Tech Lead" took the
       * full penalty.
       */
      "leader",
      "architect",
      "fellow",
      "iv",
      "v",
      "vi",
      "vii",
      "viii",
      "chief",
      "sme",
    ],
  },

  /**
   * Adjacent engineering disciplines. Not your stack, but close enough that the
   * title sails through every other filter: "Senior Software Engineer - Mobile
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
   * filter in the app: these sentences are why cold applications vanish.
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
   * Platforms that relist other companies' postings under their own name.
   * Applied to aggregator rows only: the ATS boards are curated, so a name
   * here would never match one.
   *
   * Kept deliberately short. The test for entry is "does this name hide the
   * actual employer", not "is this a company I'd rather not work for": a
   * staffing firm that hires onto its own payroll is a real employer and a real
   * application, however unglamorous. ALIQAN, Trigent and Millenium Infotech
   * are Indian services firms and are left in for that reason; add them here if
   * you decide you don't want body-shop roles, but that's a preference, not a
   * data-quality fix.
   *
   * Matched case-insensitively against the whole company name.
   */
  repostBlocklist: [
    /** Aggregator that republishes remote roles; the real employer is hidden. */
    "jobgether",
    /** Recruiting marketplace posting on behalf of unnamed clients. */
    "weekday ai",
  ],

  /**
   * How the posting's stated experience requirement scores, as a gap above
   * `yearsExperience`. A req asking for 5 more years than you have is the
   * clearest "don't bother" signal a JD emits, and it was being shown as a
   * badge and otherwise ignored.
   *
   * It's a penalty, not a gate. Plenty of "5+ years" reqs hire at three, so a
   * modest gap costs a little and a large one costs a lot, but nothing is
   * dropped for it. `maxGap` is inclusive and tiers are tried in order.
   */
  yoeGap: [
    { maxGap: 0, points: 8, label: "asks no more than you have" },
    { maxGap: 2, points: 0, label: "asks 1-2 yrs more" },
    { maxGap: 4, points: -12, label: "asks 3-4 yrs more" },
    { maxGap: Infinity, points: -25, label: "asks years more than you have" },
  ],

  /**
   * No stated requirement at all, which is two thirds of the aggregator rows.
   *
   * Scored at zero, not negative. The problem being fixed was that silence
   * outranked honesty: rows stating no experience averaged 78 while rows openly
   * asking for 8+ years averaged 64, so saying nothing was the most profitable
   * thing a posting could do. Rewarding a good stated ask with +8 fixes the
   * ordering on its own, and it does it without moving the absolute scale.
   *
   * A penalty here also does damage out of proportion to the signal: at -4 it
   * pushed "Golang Developer" and "Python Developer" (no level word, no number,
   * nothing wrong with them) to 54, just under the board's own default floor. A
   * missing field is not evidence against a role.
   *
   * The label is still emitted, so the card says why it didn't earn the +8.
   */
  yoeUnknown: { points: 0, label: "experience not stated" },

  /**
   * Freshness decay, applied at read time from `posted_at`. A req open for
   * months is usually filled, frozen, or buried under a thousand applicants.
   *
   * Deliberately weighted far lower than the old ±25: freshness barely varies
   * inside the set you browse (76% of it was posted within a week, because the
   * Adzuna queries ask for `max_days_old=30` and sort by date), so it can't
   * carry a quarter of the scale. What it can do is push genuinely old reqs
   * down, and that part is real.
   */
  freshness: [
    { maxDays: 3, points: 6, label: "posted <3d" },
    { maxDays: 7, points: 3, label: "posted this week" },
    { maxDays: 14, points: 0, label: "posted <2wk" },
    { maxDays: 30, points: -6, label: "posted <1mo" },
    { maxDays: 60, points: -14, label: "aging (1-2mo)" },
    { maxDays: 90, points: -24, label: "stale (2-3mo)" },
    { maxDays: Infinity, points: -34, label: "stale (3mo+)" },
  ],

  /** No posting date at all: mild penalty, we can't verify it's live. */
  unknownAge: { points: -6, label: "no posting date" },

  /**
   * Scoring weights. Tune these, hit Rescore, compare.
   *
   * The scale is built so that a fully-aligned role lands near 98 rather than
   * pegging: base 44, plus role 8, level 18, stack 14, experience 8, freshness
   * 6. The old weights summed to 110 against a hard clamp at 100, which put 26
   * roles on exactly 100 and 80 within five points of it. A first page of 50
   * was one tie band ordered by date.
   */
  weights: {
    base: 44,
    roleMatch: 8,
    levelMatch: 18,
    /** Senior: still shown, but never above a role in your own band. */
    levelStretch: -14,
    levelAvoid: -45,
    /** Your stack, named in the title. A deliberate signal. */
    techMatch: 14,
    /** Your stack, only in the body. Every JD lists a dozen technologies. */
    techMatchBody: 6,
    /** A stack you don't work in, named in the title. */
    offStackTech: -22,
    /** Adjacent discipline (mobile, ML, data): a real role, just not yours. */
    offStack: -18,
    /** Blocked roles can never score above this, so they sink regardless. */
    blockedCap: 15,
  },

  /**
   * Titles that contain "engineer" but aren't software engineering jobs. These
   * are customer-facing, sales, QA, IT and enterprise-platform roles; without
   * this list they sail through the gate and clutter the top of the board.
   * Dropped on refresh, not merely ranked down: they were never applications
   * you'd send.
   *
   * Substring-matched (see isEngineeringRole), which is why some entries carry
   * deliberate surrounding whitespace.
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

    // QA / test: a separate discipline and career track
    "qa engineer",
    "quality engineer",
    "quality assurance",
    "test engineer",
    "engineer in test",
    "sdet",
    "automation engineer",
    /** Data-side QA. "ETL Testing" reads as software engineering and isn't. */
    "etl testing",
    "etl tester",
    "manual testing",

    // Business systems dressed up as engineering
    "salesforce",
    "workday",
    "netsuite",
    "sap ",
    "abap",
    "business intelligence",
    "business systems",
    "information systems",
    "bus sys",
    "bizops",
    "biztech",
    /**
     * Enterprise platform configuration. Real work, different career: the day
     * job is the vendor's tooling, not a codebase.
     *
     * "oracle" is deliberately qualified rather than bare. Oracle Cloud
     * Infrastructure roles are genuine backend engineering, so only the
     * applications side is excluded.
     */
    "servicenow",
    "peoplesoft",
    "informatica",
    "cobol",
    "mainframe",
    "sharepoint",
    "oracle ebs",
    "oracle fusion",
    "oracle apps",
    "oracle developer",
    "oracle reporting",

    /**
     * Internal IT and support desks. Deliberately *not* a bare "systems
     * engineer": at infra companies that title is a real backend role, and
     * "Distributed Systems Engineer" is squarely on-stack. Only the qualified
     * forms are excluded.
     *
     * The leading spaces are load-bearing. These are substring-matched (see
     * isEngineeringRole), and "it systems" without one also fires on
     * "Credit Systems Engineer".
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
    /** Evergreen "join our talent pool" listings: no req behind them. */
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
