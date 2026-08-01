import { NextResponse } from "next/server";
import { authorized } from "@/lib/kick";
import { refreshAggregator } from "@/lib/aggregate";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Pull from the query-based aggregator (Adzuna) rather than the per-company ATS
 * boards.
 *
 *   POST /api/aggregate
 *
 * Runs inline: the queries are sequential and the whole pass takes a few
 * seconds, so there's nothing to hand off to a worker. Rows land under
 * source="adzuna" and are replaced wholesale on each run.
 *
 * Returns `error` rather than throwing when the API keys are missing, so a
 * setup that has never configured Adzuna gets a readable message instead of a
 * 500.
 */
async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshAggregator();
    return NextResponse.json(result, { status: result.error ? 400 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
