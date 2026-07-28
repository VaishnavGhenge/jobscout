import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { refreshTasks } from "@/db/schema";
import { queueSnapshot } from "@/lib/queue";

export const dynamic = "force-dynamic";

/** Read-only view of the refresh queue: per-board state, errors, last result. */
export async function GET() {
  if (!db) {
    return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 503 });
  }
  const [snapshot, tasks] = await Promise.all([
    queueSnapshot(),
    db.select().from(refreshTasks).orderBy(refreshTasks.company),
  ]);
  return NextResponse.json({ snapshot, tasks });
}
