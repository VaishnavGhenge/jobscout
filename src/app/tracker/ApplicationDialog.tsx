"use client";

import { useRef } from "react";
import type { Application, EligibilityLevel } from "@/db/schema";
import { MANUAL_SOURCES, isManualSource } from "@/lib/sources";
import { saveApplication } from "../actions";
import { SubmitButton } from "../SubmitButton";
import { STATUS_OPTIONS } from "./StatusSelect";

const ELIGIBILITY_OPTIONS: EligibilityLevel[] = [
  "eligible",
  "longshot",
  "blocked",
];

/** Date → "2026-07-24" for a date input. UTC, to match how the action stores it. */
function dateValue(d: Date | string | null): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * Add or edit an application by hand. Pass `app` to edit it, omit it to add.
 *
 * Renders its own trigger plus a native <dialog>, which buys Esc-to-close, focus
 * trapping and a real backdrop without pulling in a UI library — this project
 * has no component deps and shouldn't grow one for a single form.
 *
 * Fields are label-wrapped rather than id-linked: every card renders one of
 * these, so ids would collide across the page.
 */
export function ApplicationDialog({
  app,
  label,
  className = "btn ghost",
  pendingText = "Saving…",
}: {
  app?: Application;
  label: string;
  className?: string;
  pendingText?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A scraped row's (source, externalId) is the key the board dedupes against,
  // so only hand-added rows may change source.
  const sourceEditable = !app || isManualSource(app.source);
  const hadResponse = Boolean(app?.firstResponseAt);

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          dialogRef.current?.showModal();
          // Reopening keeps the previous scroll position otherwise.
          formRef.current?.scrollTo(0, 0);
        }}
      >
        {label}
      </button>

      <dialog
        className="modal"
        ref={dialogRef}
        aria-label={app ? "Edit application" : "Add application"}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
      >
        <form
          ref={formRef}
          action={async (fd) => {
            await saveApplication(fd);
            dialogRef.current?.close();
            // Adding is repeatable — leave the next one blank.
            if (!app) formRef.current?.reset();
          }}
        >
          <h2>{app ? "Edit application" : "Add an application"}</h2>
          <p className="modal-hint">
            {app
              ? "Yours to correct — nothing here is overwritten by a refresh."
              : "For roles you applied to outside the board — Wellfound, LinkedIn, a referral."}
          </p>

          {app && <input type="hidden" name="id" value={app.id} />}

          <label className="field">
            <span>Company</span>
            <input
              name="company"
              required
              autoComplete="off"
              placeholder="Vercel"
              defaultValue={app?.company ?? ""}
            />
          </label>

          <label className="field">
            <span>Role</span>
            <input
              name="title"
              required
              autoComplete="off"
              placeholder="Senior Software Engineer"
              defaultValue={app?.title ?? ""}
            />
          </label>

          <label className="field">
            <span>Link</span>
            <input
              name="url"
              type="url"
              autoComplete="off"
              placeholder="https://…"
              defaultValue={app?.url ?? ""}
            />
          </label>

          <div className="modal-grid">
            <label className="field">
              <span>Applied via</span>
              {sourceEditable ? (
                <select
                  name="source"
                  defaultValue={app?.source ?? MANUAL_SOURCES[0]}
                >
                  {MANUAL_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="field-static">{app?.source}</span>
              )}
            </label>

            <label className="field">
              <span>Status</span>
              <select name="status" defaultValue={app?.status ?? "applied"}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="modal-grid">
            <label className="field">
              <span>Applied on</span>
              <input
                name="appliedAt"
                type="date"
                defaultValue={dateValue(app?.appliedAt ?? null)}
              />
              <em>Blank = today, if applied</em>
            </label>

            {/* The whole reason this field exists: replies arrive on days you
                don't open the tracker, and "days to reply" is only worth
                measuring if it's the day they actually wrote. */}
            <label className="field">
              <span>They replied on</span>
              <input
                name="firstResponseAt"
                type="date"
                defaultValue={dateValue(app?.firstResponseAt ?? null)}
              />
              <em>{hadResponse ? "Clear = no reply after all" : "Blank = no reply yet"}</em>
            </label>
          </div>

          {/* Tells the action that an empty date means "clear it", not "leave it". */}
          <input type="hidden" name="hadResponse" value={hadResponse ? "1" : ""} />

          <div className="modal-grid">
            <label className="field">
              <span>Eligibility</span>
              <select
                name="eligibility"
                defaultValue={app?.eligibility ?? "eligible"}
              >
                {ELIGIBILITY_OPTIONS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Location</span>
              <input
                name="location"
                autoComplete="off"
                placeholder="Bengaluru · Remote"
                defaultValue={app?.location ?? ""}
              />
            </label>
          </div>

          <label className="check">
            <input
              type="checkbox"
              name="remote"
              defaultChecked={app?.remote ?? false}
            />
            Remote
          </label>

          <label className="field">
            <span>Notes</span>
            <textarea
              name="notes"
              rows={3}
              placeholder="Referred by…, recruiter name, salary discussed"
              defaultValue={app?.notes ?? ""}
            />
          </label>

          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <SubmitButton pendingText={pendingText}>
              {app ? "Save" : "Add to tracker"}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
