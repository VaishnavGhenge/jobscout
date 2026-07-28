import { NextResponse } from "next/server";
import { refreshAll, refreshCompanySafe } from "@/lib/refresh";
import { companies } from "@/lib/companies";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Synchronous refresh — fetches boards inline and waits for the result. Handy
 * for debugging a single connector:
 *
 *   GET /api/refresh?company=Neon
 *
 * For anything scheduled use the queue (`/api/queue/enqueue`): this path is
 * bounded by the 60s function limit and sends no ETags, so it re-downloads every
 * board in full.
 */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("company");
  if (name) {
    const company = companies.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (!company) {
      return NextResponse.json({ error: `Unknown company: ${name}` }, { status: 404 });
    }
    return NextResponse.json(await refreshCompanySafe(company));
  }
  return NextResponse.json(await refreshAll());
}
