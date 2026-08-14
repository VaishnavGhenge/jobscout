"use client";

import { useEffect, useRef } from "react";

/**
 * The search input used by the board and the tracker.
 *
 * Shared because both pages need the same two keyboard affordances: `/` from
 * anywhere on the page puts the cursor here, Esc empties it. Debouncing stays
 * with the caller — each page decides how expensive its own re-query is.
 */
export function SearchBox({
  value,
  onChange,
  onEscape,
  placeholder,
  label,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called instead of `onChange("")` on Esc, when clearing should skip a debounce. */
  onEscape?: () => void;
  placeholder: string;
  label: string;
  /** Pass one to ask the input "are you focused?" — see the callers' URL sync. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
      if (typing) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
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
        ref={ref}
        type="text"
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          if (onEscape) onEscape();
          else onChange("");
        }}
      />
      {!value && (
        <kbd className="slash" aria-hidden="true">
          /
        </kbd>
      )}
    </div>
  );
}
