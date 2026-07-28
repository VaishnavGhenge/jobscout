"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/lib/time";
import { continueRefresh } from "./actions";

export interface RunStatusProps {
  total: number;
  done: number;
  pending: number;
  running: number;
  unchanged: number;
  dead: number;
  /** ISO string — Dates don't survive the server/client boundary intact. */
  lastRunAt: string | null;
  problems: { company: string; state: string; error: string | null }[];
}

/** How often to re-check while a run is in flight. */
const POLL_MS = 4000;

/**
 * Live state of the refresh queue. While boards are still being fetched this
 * polls the server component so progress appears without the user reloading;
 * when the queue drains it settles into a one-line summary and stops polling.
 */
export function RunStatus(props: RunStatusProps) {
  const router = useRouter();
  const busy = props.pending > 0;
  const draining = useRef(false);

  // Keep the page in step with whoever is draining the queue.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [busy, router]);

  // A single worker invocation is time-boxed, so a cold run needs more than one.
  // While this tab is open it drives the next slice itself; if it's closed, the
  // leftovers just wait for the next scheduled tick. One in flight at a time.
  useEffect(() => {
    if (!busy || draining.current) return;
    draining.current = true;
    continueRefresh()
      .catch(() => {})
      .finally(() => {
        draining.current = false;
        router.refresh();
      });
  }, [busy, props.done, router]);

  if (busy) {
    return (
      <div className="runstatus busy" aria-live="polite">
        <span className="spinner dim" aria-hidden="true" />
        <span>
          refreshing boards · {props.done}/{props.total} done
          {props.running > 0 ? ` · ${props.running} in flight` : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="runstatus" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span>
        last run {timeAgo(props.lastRunAt)} · {props.done}/{props.total} boards
        {props.unchanged > 0 ? ` · ${props.unchanged} unchanged` : ""}
      </span>
      {props.problems.map((p) => (
        <span
          className="badge bad-badge"
          key={p.company}
          title={p.error ?? "failed"}
        >
          {p.company} {p.state === "dead" ? "failed" : "retrying"}
        </span>
      ))}
    </div>
  );
}
