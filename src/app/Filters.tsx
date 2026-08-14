"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { FILTER_DEFAULTS } from "@/lib/filter-defaults";
import { SearchBox } from "./SearchBox";

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
  /** Max years of experience asked for; "" for any. */
  maxYoe: string;
  /** "show" surfaces dismissed roles instead of hiding them. */
  dismissed: string;
}

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
  const input = useRef<HTMLInputElement>(null);

  function apply(next: Partial<FilterState>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) sp.delete(k);
      else sp.set(k, v);
    }
    // Any filter change invalidates the current page. Staying on page 6 while
    // narrowing 900 results to 40 lands the reader on an empty screen.
    sp.delete("page");
    startTransition(() =>
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false }),
    );
  }

  function onSearch(v: string) {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => apply({ q: v }), 350);
  }

  // Follow the URL when something other than typing changes it — Back, Forward,
  // a link that sets `q`. Skipped while the box has focus: a slow round trip
  // would otherwise reel the box back to a stale value mid-word.
  useEffect(() => {
    if (document.activeElement !== input.current) setText(initial.q);
  }, [initial.q]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const isActive =
    Boolean(initial.q) ||
    Boolean(initial.source) ||
    Boolean(initial.maxAge) ||
    Boolean(initial.maxYoe) ||
    initial.dismissed === "show" ||
    initial.remote === "1" ||
    initial.tracked === "hide" ||
    initial.minScore !== FILTER_DEFAULTS.minScore ||
    initial.elig !== FILTER_DEFAULTS.elig ||
    (initial.sort !== "" && initial.sort !== FILTER_DEFAULTS.sort);

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
        placeholder="Search title or company…"
        label="Search title or company"
        inputRef={input}
      />
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
        <option value="3">Posted ≤ 3d</option>
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
        <option value="adzuna">Adzuna (aggregated)</option>
      </select>
      <select
        value={initial.maxYoe}
        onChange={(e) => apply({ maxYoe: e.target.value })}
        aria-label="Maximum experience asked for"
        title="Postings that don't state a requirement are always kept"
      >
        <option value="">Any experience</option>
        <option value="2">Asks ≤ 2 yrs</option>
        <option value="3">Asks ≤ 3 yrs</option>
        <option value="5">Asks ≤ 5 yrs</option>
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
      <label className="check" title="Show roles you've ruled out">
        <input
          type="checkbox"
          checked={initial.dismissed === "show"}
          onChange={(e) => apply({ dismissed: e.target.checked ? "show" : "" })}
        />
        Show dismissed
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
