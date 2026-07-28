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
    url: text("url").notNull(),
    remote: boolean("remote").notNull().default(false),
    department: text("department").notNull().default(""),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    score: integer("score").notNull().default(0),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    eligibility: eligibilityLevel("eligibility").notNull().default("longshot"),
    eligibilityReason: text("eligibility_reason").notNull().default(""),
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
export type RefreshTask = typeof refreshTasks.$inferSelect;
export type TaskState = (typeof taskState.enumValues)[number];
export type EligibilityLevel = (typeof eligibilityLevel.enumValues)[number];
