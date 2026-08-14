"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { TRACKER_DEFAULTS } from "@/lib/filter-defaults";
import { GHOST_AFTER_DAYS } from "@/lib/insights";
import { SearchBox } from "../SearchBox";

export interface TrackerFilterState {
  q: string;
  /** "" | "waiting" | "ghosted" | "replied" — where the ball is. */
  reply: string;
  /** Applied via; "" for any. */
  src: string;
  /** "updated" (default) | "waiting" | "applied". */
  sort: string;
}

/**
 * Filter bar for the pipeline. Same URL-driven shape as the board's Filters, so
 * a filtered view is a link you can keep, and the columns stay server-rendered.
 *
 * The point of this bar is finding one card in a pipeline of a hundred — you
 * heard back from someone and need their card *now*, not after scrolling five
 * columns.
 */
export function TrackerFilters({
  sources,
  ...initial
}: TrackerFilterState & { sources: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [text, setText] = useState(initial.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function apply(next: Partial<TrackerFilterState>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    startTransition(() =>
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }),
    );
  }

  function onSearch(v: string) {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => apply({ q: v }), 250);
  }

  // Follow the URL when something other than typing changes it — Back, Forward,
  // a click on one of the funnel numbers. Skipped while the box has focus, so a
  // slow round trip can't reel it back to a stale value mid-word.
  useEffect(() => {
    if (document.activeElement !== input.current) setText(initial.q);
  }, [initial.q]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const isActive =
    Boolean(initial.q) ||
    Boolean(initial.reply) ||
    Boolean(initial.src) ||
    (initial.sort !== "" && initial.sort !== TRACKER_DEFAULTS.sort);

  function clear() {
    if (timer.current) clearTimeout(timer.current);
    setText("");
    startTransition(() => router.replace(pathname, { scroll: false }));
  }

  return (
    <div className={`filters${isPending ? " updating" : ""}`} aria-busy={isPending}>
      <SearchBox
        value={text}
        onChange={onSearch}
        onEscape={() => {
          if (timer.current) clearTimeout(timer.current);
          setText("");
          apply({ q: "" });
        }}
        placeholder="Search company, role or notes…"
        label="Search applications"
        inputRef={input}
      />
      <select
        value={initial.reply}
        onChange={(e) => apply({ reply: e.target.value })}
        aria-label="Reply state"
        title="Whose turn it is"
      >
        <option value="">Any reply state</option>
        <option value="waiting">Waiting on them</option>
        <option value="ghosted">Silent {GHOST_AFTER_DAYS}d+</option>
        <option value="replied">Replied</option>
      </select>
      <select
        value={initial.src}
        onChange={(e) => apply({ src: e.target.value })}
        aria-label="Applied via"
      >
        <option value="">Any source</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select
        value={initial.sort || TRACKER_DEFAULTS.sort}
        onChange={(e) => apply({ sort: e.target.value })}
        aria-label="Sort order"
      >
        <option value="updated">Sort: last touched</option>
        <option value="waiting">Sort: longest waiting</option>
        <option value="applied">Sort: most recently applied</option>
      </select>
      {isPending && <span className="spinner dim" aria-hidden="true" />}
      {isActive && (
        <button className="btn ghost small" type="button" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  );
}
