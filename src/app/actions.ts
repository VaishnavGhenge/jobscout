"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { eq, sql } from "drizzle-orm";
import { requireDb } from "@/db/client";
import {
  applications,
  type ApplicationStatus,
  type EligibilityLevel,
} from "@/db/schema";
import { enqueueAll } from "@/lib/queue";
import { drain } from "@/lib/worker";

/** Statuses that can only be reached after somebody replied to you. */
const IMPLIES_RESPONSE: ApplicationStatus[] = [
  "interviewing",
  "offer",
  "rejected",
];

function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/tracker");
  revalidatePath("/insights");
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

export async function updateNotes(formData: FormData): Promise<void> {
  const db = requireDb();
  const id = Number(formData.get("id"));
  const notes = String(formData.get("notes") ?? "");
  await db
    .update(applications)
    .set({ notes, updatedAt: sql`now()` })
    .where(eq(applications.id, id));
  revalidatePath("/tracker");
}

export async function removeApplication(formData: FormData): Promise<void> {
  const db = requireDb();
  const id = Number(formData.get("id"));
  await db.delete(applications).where(eq(applications.id, id));
  revalidateAll();
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
