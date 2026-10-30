import { NextResponse } from "next/server";
import { rescoreAll } from "@/lib/rescore";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Re-score every stored row against the current profile:
 *
 *   POST /api/rescore
 *
 * No network calls, so this is the loop for tuning src/lib/profile.ts. Edit a
 * weight, rescore, look at the board. Previously the only way to see a weight
 * change was to refetch all 84 boards and hope.
 *
 * GET is allowed for the same reason /api/refresh allows it: it's convenient
 * from a browser and it can't lose data, since every value it writes is derived
 * from the stored row.
 */
export async function POST() {
  return NextResponse.json(await rescoreAll());
}

export const GET = POST;
