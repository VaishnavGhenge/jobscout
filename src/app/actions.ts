"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db/client";
import {
  applications,
  dismissReason,
  dismissals,
  type ApplicationStatus,
  type DismissReason,
  type EligibilityLevel,
} from "@/db/schema";
import { enqueueAll } from "@/lib/queue";
import { isChannel } from "@/lib/sources";
import { rescoreAll } from "@/lib/rescore";
import { drain } from "@/lib/worker";

/** Statuses that can only be reached after somebody replied to you. */
const IMPLIES_RESPONSE: ApplicationStatus[] = [
  "interviewing",
  "offer",
  "rejected",
];

/** Statuses that mean you got past screening. See `applications.shortlistedAt`. */
const IMPLIES_SHORTLIST: ApplicationStatus[] = ["interviewing", "offer"];

function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/tracker");
  revalidatePath("/insights");
  revalidatePath("/alerts");
}

/** Add a job to the tracker (idempotent on source+externalId). */
export async function trackJob(formData: FormData): Promise<void> {
  const db = requireDb();
  const str = (k: string) => String(formData.get(k) ?? "");
  const postedAt = str("postedAt");

  await db
    .insert(applications)
    .values({
      source: str("source"),
      externalId: str("externalId"),
      company: str("company"),
      title: str("title"),
      url: str("url"),
      // Snapshot the posting as it looks right now — the live job row will be
      // replaced on the next refresh, taking this context with it.
      location: str("location"),
      remote: str("remote") === "true",
      score: Number(formData.get("score") ?? 0),
      eligibility: (str("eligibility") || "longshot") as EligibilityLevel,
      postedAt: postedAt ? new Date(postedAt) : null,
    })
    .onConflictDoNothing({
      target: [applications.source, applications.externalId],
    });

  revalidateAll();
}

/**
 * Create or edit an application by hand — the ones you sent through LinkedIn,
 * Wellfound or a referral, which no connector will ever scrape.
 *
 * With an `id` this edits; without one it inserts. Manual rows get a generated
 * `externalId` because the table is unique on (source, externalId) and every
 * hand-added row needs its own key.
 */
export async function saveApplication(formData: FormData): Promise<void> {
  const db = requireDb();
  const str = (k: string) => String(formData.get(k) ?? "").trim();

  const company = str("company");
  const title = str("title");
  if (!company && !title) return;

  const rawId = str("id");
  const id = rawId ? Number(rawId) : null;
  const status = (str("status") || "saved") as ApplicationStatus;
  const source = str("source");
  const rawChannel = str("channel");

  // A date input gives "2026-07-24". Pin it to UTC midnight so the value reads
  // back as the same day on both the server and the browser — a local-midnight
  // stamp renders as two different dates in the two places.
  const appliedOn = str("appliedAt");
  const appliedAt = appliedOn
    ? new Date(`${appliedOn}T00:00:00Z`)
    : status === "applied" || IMPLIES_RESPONSE.includes(status)
      ? new Date()
      : null;

  // A reply date you typed wins over anything inferred from the status. Emptying
  // a field that had one means "that reply never happened"; leaving a field that
  // was never set empty falls through to the status rule below. Without this,
  // `firstResponseAt` could only ever be "the day I got round to opening the
  // tracker", which makes time-to-reply unmeasurable.
  const repliedOn = str("firstResponseAt");
  const reply: Date | null | undefined = repliedOn
    ? new Date(`${repliedOn}T00:00:00Z`)
    : str("hadResponse") === "1"
      ? null
      : undefined;

  // Same shape as the reply date: a ticked box keeps the first stamp, an
  // unticked one clears it, and an interviewing or offer status ticks it for you.
  // Logging an old form application that went to interview and then a rejection
  // is exactly the case the status alone would lose.
  const shortlisted =
    formData.get("shortlisted") === "on" || IMPLIES_SHORTLIST.includes(status);

  const fields = {
    company,
    title,
    url: str("url"),
    status,
    notes: str("notes"),
    location: str("location"),
    remote: formData.get("remote") === "on",
    eligibility: (str("eligibility") || "eligible") as EligibilityLevel,
    appliedAt,
    ...(isChannel(rawChannel) ? { channel: rawChannel } : {}),
  };

  if (id) {
    await db
      .update(applications)
      .set({
        ...fields,
        // Only manual rows expose a source input. Leaving a scraped row's
        // (source, externalId) alone is what keeps the board still showing it
        // as tracked.
        ...(source ? { source } : {}),
        ...(reply !== undefined
          ? { firstResponseAt: reply }
          : IMPLIES_RESPONSE.includes(status) || shortlisted
            ? {
                firstResponseAt: sql`coalesce(${applications.firstResponseAt}, now())`,
              }
            : {}),
        shortlistedAt: shortlisted
          ? sql`coalesce(${applications.shortlistedAt}, now())`
          : null,
        updatedAt: sql`now()`,
      })
      .where(eq(applications.id, id));
  } else {
    await db.insert(applications).values({
      ...fields,
      source: source || "other",
      externalId: crypto.randomUUID(),
      firstResponseAt:
        reply ??
        (IMPLIES_RESPONSE.includes(status) || shortlisted ? new Date() : null),
      shortlistedAt: shortlisted ? new Date() : null,
    });
  }

  revalidateAll();
}

/**
 * Move an application through the pipeline, stamping the dates that make
 * response rate measurable. Both stamps use COALESCE so the *first* time you
 * reached a state is what's recorded, even if you flip statuses later.
 */
export async function setStatus(formData: FormData): Promise<void> {
  const db = requireDb();
  const id = Number(formData.get("id"));
  const status = String(formData.get("status")) as ApplicationStatus;

  const patch: Record<string, unknown> = { status, updatedAt: sql`now()` };
  if (status === "applied" || IMPLIES_RESPONSE.includes(status)) {
    patch.appliedAt = sql`coalesce(${applications.appliedAt}, now())`;
  }
  if (IMPLIES_RESPONSE.includes(status)) {
    patch.firstResponseAt = sql`coalesce(${applications.firstResponseAt}, now())`;
  }
  if (IMPLIES_SHORTLIST.includes(status)) {
    patch.shortlistedAt = sql`coalesce(${applications.shortlistedAt}, now())`;
  }

  await db.update(applications).set(patch).where(eq(applications.id, id));
  revalidateAll();
}

/**
 * Record a reply that doesn't change the pipeline stage — a recruiter email, an
 * acknowledgement, a "we'll be in touch". Without this, any response that isn't
 * an interview invite is invisible to the funnel.
 */
export async function markReplied(formData: FormData): Promise<void> {
  const db = requireDb();
  const id = Number(formData.get("id"));
  await db
    .update(applications)
    .set({
      firstResponseAt: sql`coalesce(${applications.firstResponseAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(eq(applications.id, id));
  revalidateAll();
}

export async function removeApplication(formData: FormData): Promise<void> {
  const db = requireDb();
  const id = Number(formData.get("id"));
  await db.delete(applications).where(eq(applications.id, id));
  revalidateAll();
}

/**
 * Rule a role out so the board stops showing it. Idempotent on
 * (source, externalId), like tracking, so a double-click is harmless.
 *
 * Deliberately not a delete of the job row: the next refresh would re-insert it
 * and the dismissal would silently undo itself.
 */
export async function dismissJob(formData: FormData): Promise<void> {
  const db = requireDb();
  const str = (k: string) => String(formData.get(k) ?? "");

  // The reason is what makes a dismissal worth recording. Without it the table
  // only ever said "no" and the scoring had nothing to learn from: the single
  // dismissal on record was a C#/Angular role sitting at 100, and the board had
  // no way to notice that it had been overruled.
  const raw = str("reason");
  const reason: DismissReason = (
    dismissReason.enumValues as readonly string[]
  ).includes(raw)
    ? (raw as DismissReason)
    : "other";

  await db
    .insert(dismissals)
    .values({
      source: str("source"),
      externalId: str("externalId"),
      company: str("company"),
      title: str("title"),
      reason,
      score: Number(formData.get("score") ?? 0),
    })
    .onConflictDoNothing({
      target: [dismissals.source, dismissals.externalId],
    });

  revalidatePath("/");
}

/**
 * Re-score the board against the current profile, no refetch.
 *
 * The counterpart to "Refresh now": refresh answers "what's out there", this
 * answers "given what I've told you about myself, how should it be ranked".
 * Separating them is the point, since a tuning change used to require a full
 * crawl before it could be judged.
 */
export async function rescoreNow(): Promise<void> {
  await rescoreAll();
  revalidateAll();
}

/** Put a dismissed role back on the board. */
export async function restoreJob(formData: FormData): Promise<void> {
  const db = requireDb();
  await db
    .delete(dismissals)
    .where(
      and(
        eq(dismissals.source, String(formData.get("source") ?? "")),
        eq(dismissals.externalId, String(formData.get("externalId") ?? "")),
      ),
    );
  revalidatePath("/");
}

/**
 * Manual "Refresh now" from the board header. Queues every board and returns
 * straight away — the button shouldn't hold a request open for the length of a
 * full run. A worker starts draining after the response is sent, and the board's
 * status strip polls until the queue is empty.
 */
export async function refreshNow(): Promise<void> {
  await enqueueAll();
  after(async () => {
    await drain();
  });
  revalidatePath("/");
}

/**
 * Drain one more slice of the queue. Called by the board's status strip while a
 * run is unfinished, so an open tab carries the run to completion instead of
 * leaving the tail for the next scheduled tick. Returns what's still claimable.
 */
export async function continueRefresh(): Promise<number> {
  const summary = await drain();
  revalidatePath("/");
  return summary.remaining;
}
