import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const applicationStatus = pgEnum("application_status", [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
]);

/**
 * How the application reached the company, as opposed to `source`, which is
 * where you found the role.
 *
 * The two used to share one column, and that hid the one pattern the tracker
 * had to offer: applications sent through a recruiter's Google Form, linked from
 * a LinkedIn post, got shortlisted, and ATS applications didn't. A role found on
 * LinkedIn can go in through any of these, so "linkedin" as a source said
 * nothing about which door you used. Labels live in lib/sources.ts.
 */
export const applicationChannel = pgEnum("application_channel", [
  "ats",
  "hr_form",
  "recruiter_direct",
  "referral",
  "quick_apply",
  "other",
]);

/** Whether you could actually be hired for a role. See lib/eligibility.ts. */
export const eligibilityLevel = pgEnum("eligibility_level", [
  "eligible",
  "longshot",
  "blocked",
]);

/**
 * Cached job postings pulled from company ATS boards. Rows are replaced per
 * company on every refresh, so treat these as ephemeral — the tracker keeps its
 * own snapshot (see `applications`) and never depends on a job row surviving.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(), // greenhouse | lever | ashby
    externalId: text("external_id").notNull(),
    company: text("company").notNull(),
    title: text("title").notNull(),
    location: text("location").notNull().default(""),
    /**
     * Every location the role is open in, and the board's country code when it
     * gives one. Stored alongside the parsed `regions` because parsing is the
     * lossy step: keeping the inputs is what lets `profile.basedIn` change and
     * be reassessed by a rescore rather than a full recrawl.
     */
    locations: jsonb("locations").$type<string[]>().notNull().default([]),
    countryCode: text("country_code"),
    url: text("url").notNull(),
    remote: boolean("remote").notNull().default(false),
    department: text("department").notNull().default(""),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /**
     * Plain-text job description, as fetched.
     *
     * Kept rather than discarded after extraction, which is how this started.
     * Four things were parsed out of it (blockers, pay band, experience ask,
     * stack keywords) and then the text was dropped, so every tuning change to
     * a parser or a keyword list needed all 84 boards refetched before you could
     * see whether it helped, and no change could be tested against the rows
     * already sitting here. It also makes the board searchable on JD text, which
     * a title-only search can't be.
     *
     * Empty for rows written before this column existed, and for anything the
     * source truncates: Adzuna's search API returns roughly 200 characters.
     */
    description: text("description").notNull().default(""),
    /**
     * Fit score, 0-100. Time-independent by design: freshness is applied when
     * the board is read (lib/freshness.ts), because a stored decay term is stale
     * the day after it's written and 553 rows were proof of it.
     */
    score: integer("score").notNull().default(0),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    eligibility: eligibilityLevel("eligibility").notNull().default("longshot"),
    eligibilityReason: text("eligibility_reason").notNull().default(""),
    /**
     * Stated pay band, e.g. "₹25L–35L" or "$150k–200k". Null when the posting
     * doesn't publish one, which is most of them — that means "unknown", never
     * "pays badly", which is why nothing scores on it.
     */
    compLabel: text("comp_label"),
    /**
     * Years of experience the posting asks for, read from the title first and
     * the body second. Null when neither says, which is two thirds of the
     * aggregator rows: that means "unknown", never "no requirement", and
     * profile.yoeUnknown prices it accordingly.
     */
    yoeMin: integer("yoe_min"),
    /** Upper bound when a range is stated ("3-5 years"), else null. */
    yoeMax: integer("yoe_max"),
    /** Description phrases that would screen you out (visa, clearance, …). */
    blockers: jsonb("blockers").$type<string[]>().notNull().default([]),
    regions: jsonb("regions").$type<string[]>().notNull().default([]),
    /**
     * When this posting first appeared on our board — carried across refreshes,
     * unlike `fetchedAt`. "New since yesterday" is the highest-response cohort
     * there is, and it's unknowable without this.
     */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_source_external_idx").on(t.source, t.externalId),
    index("jobs_company_idx").on(t.company),
    index("jobs_score_idx").on(t.score),
    index("jobs_eligibility_idx").on(t.eligibility),
    index("jobs_posted_idx").on(t.postedAt),
  ],
);

/**
 * The user's application pipeline. Snapshots company/title/url so a tracked role
 * stays visible even after it's delisted and the job row is gone. Keyed on
 * (source, externalId) so "Track" is idempotent.
 *
 * The snapshot deliberately includes the job's location, score, eligibility and
 * posting date *as they were when you applied* — that's what makes it possible
 * to ask "which kinds of applications actually get replies?" later. Reading it
 * back off the live `jobs` row wouldn't work: those rows get replaced.
 */
export const applications = pgTable(
  "applications",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    company: text("company").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    status: applicationStatus("status").notNull().default("saved"),
    /** How you applied. See `applicationChannel`. Board rows go in via the ATS. */
    channel: applicationChannel("channel").notNull().default("ats"),
    notes: text("notes").notNull().default(""),

    // --- Snapshot of the posting, for response-rate analysis ---------------
    location: text("location").notNull().default(""),
    remote: boolean("remote").notNull().default(false),
    score: integer("score").notNull().default(0),
    eligibility: eligibilityLevel("eligibility").notNull().default("longshot"),
    /** When the role was posted — lets us measure age-at-application. */
    postedAt: timestamp("posted_at", { withTimezone: true }),

    // --- The dates that answer "why am I not hearing back?" ----------------
    /** When you actually applied. `createdAt` is only when you saved it. */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** First human or automated reply of any kind, including a rejection. */
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    /**
     * First time this got past screening: a call, an interview, an assignment.
     * A rejection counts as a reply, so reply rate alone can't tell a channel
     * that shortlists you from one that sends polite no's. Kept as its own stamp
     * because `status` moves on: an interview that ends in a rejection still
     * counts here.
     */
    shortlistedAt: timestamp("shortlisted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("applications_source_external_idx").on(t.source, t.externalId),
    index("applications_applied_idx").on(t.appliedAt),
  ],
);

/**
 * Why a role was ruled out.
 *
 * Every value maps onto a lever in profile.ts, which is the whole point: a
 * dismissal is the cheapest label the system will ever get, and until now it
 * recorded only that you'd said no, never what you were saying no to. The one
 * dismissal on record was a C#/Angular role scoring 100, which is a finding the
 * board could have surfaced by itself given a reason column.
 *
 * - `stack`    -> profile.offStackTech / techKeywords
 * - `level`    -> profile.seniority, profile.yoeGap
 * - `domain`   -> profile.offStackDomains
 * - `location` -> profile.basedIn, lib/regions.ts
 * - `pay`      -> lib/comp.ts (unscored, deliberately)
 * - `company`  -> a judgement about the employer, not a tuning signal
 * - `other`    -> unclassified, so a dismissal never needs a reason to happen
 */
export const dismissReason = pgEnum("dismiss_reason", [
  "stack",
  "level",
  "domain",
  "location",
  "pay",
  "company",
  "other",
]);

/**
 * Roles you've looked at and ruled out.
 *
 * Separate from `applications` on purpose: a dismissal is the absence of intent,
 * and folding it in as another status would corrupt every funnel number in
 * insights.ts — a rejected application and a role you never wanted are not the
 * same event.
 *
 * Keyed on (source, externalId) like the tracker, so a dismissal survives the
 * job row being deleted and re-inserted on the next refresh. Without that, every
 * role you dismissed would come straight back a few hours later.
 */
export const dismissals = pgTable(
  "dismissals",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    /** Snapshot for the "dismissed" view — the job row may be gone. */
    company: text("company").notNull().default(""),
    title: text("title").notNull().default(""),
    /** Why you ruled it out. See `dismissReason`. */
    reason: dismissReason("reason").notNull().default("other"),
    /**
     * The fit score at the moment you dismissed it. A high score here is the
     * signal worth acting on: it means the ranking disagreed with you, and the
     * reason says which weight was wrong.
     */
    score: integer("score").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("dismissals_source_external_idx").on(t.source, t.externalId),
    index("dismissals_reason_idx").on(t.reason),
  ],
);

export const taskState = pgEnum("task_state", [
  "queued",
  "running",
  "done",
  /** Failed, but will be retried after `runAfter`. */
  "failed",
  /** Out of attempts. Won't be retried until the next full enqueue. */
  "dead",
]);

/**
 * The refresh queue: exactly one durable row per company, which doubles as the
 * status board ("which boards failed on the last run, and why").
 *
 * Workers claim rows with a lease rather than deleting them, so a worker that
 * dies mid-fetch — a serverless timeout, a redeploy — releases its task when the
 * lease expires instead of losing it. See lib/queue.ts.
 */
export const refreshTasks = pgTable(
  "refresh_tasks",
  {
    id: serial("id").primaryKey(),
    company: text("company").notNull(),
    state: taskState("state").notNull().default("queued"),
    /** Attempts within the current run. Reset on enqueue, not on success. */
    attempts: integer("attempts").notNull().default(0),
    /** Not eligible to be claimed before this. Backoff is written here. */
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** While `running`, the deadline after which another worker may steal it. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),

    // --- Cache validators, so an unchanged board costs a 304 -----------------
    etag: text("etag"),
    lastModified: text("last_modified"),

    // --- Outcome of the last attempt, for the status strip -------------------
    lastError: text("last_error"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastDurationMs: integer("last_duration_ms"),
    /** Counts from the last successful attempt: kept, eligible, fresh. */
    lastResult: jsonb("last_result").$type<Record<string, number>>(),
    /** Last attempt was a 304 — nothing re-fetched, nothing rewritten. */
    lastUnchanged: boolean("last_unchanged").notNull().default(false),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("refresh_tasks_company_idx").on(t.company),
    index("refresh_tasks_claim_idx").on(t.state, t.runAfter),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type ApplicationStatus = (typeof applicationStatus.enumValues)[number];
export type Dismissal = typeof dismissals.$inferSelect;
export type RefreshTask = typeof refreshTasks.$inferSelect;
export type TaskState = (typeof taskState.enumValues)[number];
export type EligibilityLevel = (typeof eligibilityLevel.enumValues)[number];
export type DismissReason = (typeof dismissReason.enumValues)[number];
export type ApplicationChannel = (typeof applicationChannel.enumValues)[number];
