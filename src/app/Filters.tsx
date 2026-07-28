"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export interface FilterState {
  q: string;
  source: string;
  minScore: string;
  remote: string;
  sort: string;
  /** "open" (default, hides blocked), "eligible", or "" for everything. */
  elig: string;
  /** Max posting age in days; "" for any. */
  maxAge: string;
  /** "hide" drops roles already in the tracker; "" shows everything. */
  tracked: string;
}

/** Defaults, kept here so "is a filter active?" and Clear agree on what's normal. */
export const FILTER_DEFAULTS = {
  minScore: "45",
  elig: "open",
  sort: "score",
} as const;

/**
 * Auto-applying filter bar. Selects/checkbox apply instantly; the search box is
 * debounced. Uses router.replace (RSC navigation, no full reload) inside a
 * transition so the bar can show a live "updating" state.
 */
export function Filters(initial: FilterState) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [text, setText] = useState(initial.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function apply(next: Partial<FilterState>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) sp.delete(k);
      else sp.set(k, v);
    }
    startTransition(() =>
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false }),
    );
  }

  function onSearch(v: string) {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => apply({ q: v }), 350);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const isActive =
    Boolean(initial.q) ||
    Boolean(initial.source) ||
    Boolean(initial.maxAge) ||
    initial.remote === "1" ||
    initial.tracked === "hide" ||
    initial.minScore !== FILTER_DEFAULTS.minScore ||
    initial.elig !== FILTER_DEFAULTS.elig ||
    (initial.sort !== "" && initial.sort !== FILTER_DEFAULTS.sort);

  function clear() {
    setText("");
    startTransition(() => router.replace(pathname, { scroll: false }));
  }

  return (
    <div className={`filters${isPending ? " updating" : ""}`} aria-busy={isPending}>
      <div className="search">
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <circle
            cx="6"
            cy="6"
            r="4.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M9.4 9.4 12.6 12.6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="text"
          placeholder="Search title or company…"
          aria-label="Search title or company"
          value={text}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      <select
        value={initial.elig}
        onChange={(e) => apply({ elig: e.target.value })}
        aria-label="Eligibility"
        title="Whether you could actually be hired for the role"
      >
        <option value="open">Can apply (default)</option>
        <option value="eligible">Eligible only</option>
        <option value="all">Include blocked</option>
      </select>
      <select
        value={initial.maxAge}
        onChange={(e) => apply({ maxAge: e.target.value })}
        aria-label="Maximum posting age"
        title="Older reqs are usually filled, frozen, or buried"
      >
        <option value="">Any age</option>
        <option value="7">Posted ≤ 7d</option>
        <option value="14">Posted ≤ 14d</option>
        <option value="30">Posted ≤ 30d</option>
      </select>
      <select
        value={initial.source}
        onChange={(e) => apply({ source: e.target.value })}
        aria-label="Job board"
      >
        <option value="">All sources</option>
        <option value="greenhouse">Greenhouse</option>
        <option value="ashby">Ashby</option>
        <option value="lever">Lever</option>
        <option value="smartrecruiters">SmartRecruiters</option>
        <option value="rippling">Rippling</option>
      </select>
      <select
        value={initial.minScore}
        onChange={(e) => apply({ minScore: e.target.value })}
        aria-label="Minimum fit score"
      >
        <option value="0">Any score</option>
        <option value="45">45+ relevant</option>
        <option value="60">60+ good fit</option>
        <option value="75">75+ strong</option>
      </select>
      <select
        value={initial.sort || FILTER_DEFAULTS.sort}
        onChange={(e) => apply({ sort: e.target.value })}
        aria-label="Sort order"
      >
        <option value="score">Sort: best bet</option>
        <option value="recent">Sort: newest posting</option>
        <option value="new">Sort: new to board</option>
      </select>
      <label className="check">
        <input
          type="checkbox"
          checked={initial.remote === "1"}
          onChange={(e) => apply({ remote: e.target.checked ? "1" : "" })}
        />
        Remote only
      </label>
      <label className="check" title="Hide roles already in your tracker">
        <input
          type="checkbox"
          checked={initial.tracked === "hide"}
          onChange={(e) => apply({ tracked: e.target.checked ? "hide" : "" })}
        />
        Untracked only
      </label>
      {isPending && <span className="spinner dim" aria-hidden="true" />}
      {isActive && (
        <button className="btn ghost small" type="button" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  );
}
