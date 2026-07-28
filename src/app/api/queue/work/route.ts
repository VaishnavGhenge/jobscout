import { NextResponse } from "next/server";
import { authorized } from "@/lib/kick";
import { drain } from "@/lib/worker";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Drains the refresh queue for as long as this invocation safely can, then
 * reports what's left. Safe to call concurrently — claiming is atomic, so two
 * workers never touch the same company.
 *
 * It does *not* chain to itself: whoever is driving the run (the scheduler loop,
 * or the board's status strip while a tab is open) calls again while `remaining`
 * is above zero. That keeps the "who is responsible for finishing the run"
 * question in one place instead of splitting it across nested invocations.
 */
async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await drain());
}

export const GET = handle;
export const POST = handle;
