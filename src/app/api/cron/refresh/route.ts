import { after, NextResponse } from "next/server";
import { authorized, kickWorker } from "@/lib/kick";
import { enqueueAll } from "@/lib/queue";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Scheduled refresh (see vercel.json, or .github/workflows/refresh.yml for a
 * faster cadence than Hobby cron allows).
 *
 * This only *queues* the work and returns — the boards are fetched by worker
 * invocations, so the run isn't capped by this request's 60s budget. When
 * CRON_SECRET is set, Vercel sends it as a Bearer token and anything else is
 * rejected, so the endpoint isn't public.
 */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const queued = await enqueueAll();
  after(async () => {
    await kickWorker(new URL(req.url).origin);
  });
  return NextResponse.json({ ok: true, queued });
}
