import { after, NextResponse } from "next/server";
import { authorized, kickWorker } from "@/lib/kick";
import { enqueueAll, enqueueCompany, queueSnapshot } from "@/lib/queue";
import { companies } from "@/lib/companies";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Seed the refresh queue and start a worker.
 *
 *   POST /api/queue/enqueue                → queue every company
 *   POST /api/queue/enqueue?company=Neon   → queue one board
 *
 * Returns immediately; the work happens in the worker invocations that follow.
 */
async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const name = url.searchParams.get("company");

  let queued: number;
  if (name) {
    const company = companies.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (!company) {
      return NextResponse.json(
        { error: `Unknown company: ${name}` },
        { status: 404 },
      );
    }
    await enqueueCompany(company.name);
    queued = 1;
  } else {
    queued = await enqueueAll();
  }

  after(async () => {
    await kickWorker(url.origin);
  });

  return NextResponse.json({ ok: true, queued, queue: await queueSnapshot() });
}

export const GET = handle;
export const POST = handle;
