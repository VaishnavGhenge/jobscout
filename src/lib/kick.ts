/**
 * Triggering the worker over HTTP.
 *
 * Call this only from inside `after()`, so the response has already been sent
 * and the caller isn't waiting on the run.
 *
 * It deliberately awaits the worker's full response. The obvious alternative —
 * start the request, abort it after a second, let the worker run on — does not
 * work: Next aborts the route handler when its caller disconnects, so the
 * "fire and forget" trigger kills the worker mid-fetch. (Verified: the worker
 * returned in exactly the abort timeout, having processed half the queue.)
 *
 * Nothing depends on this call succeeding. A worker that dies leaves its task
 * claimable once the lease expires, so the next scheduler tick recovers it.
 */
const CEILING_MS = 55_000;

export async function kickWorker(origin: string): Promise<string> {
  const secret = process.env.CRON_SECRET;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CEILING_MS);
  try {
    const res = await fetch(`${origin}/api/queue/work`, {
      method: "POST",
      signal: controller.signal,
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      cache: "no-store",
    });
    return `worker ${res.status}`;
  } catch (err) {
    return `worker not reached: ${err instanceof Error ? err.message : err}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Bearer check for the queue endpoints. Open only when no secret is set. */
export function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
