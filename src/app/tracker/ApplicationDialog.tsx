"use client";

import { useRef, useState } from "react";
import type { Application, EligibilityLevel } from "@/db/schema";
import { CHANNELS, MANUAL_SOURCES, isManualSource } from "@/lib/sources";
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
 *
 * Field order follows how you log a form application from memory: who, what,
 * which door, when, and whether it went anywhere. Where you found the role and
 * the posting snapshot (eligibility, location) sit under "More details", since
 * a hand-logged row rarely has anything useful to say there.
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
  // Backfilling means a run of entries in one sitting. "Save & add another"
  // keeps the dialog open and says what went in, so you know it took.
  const [lastSaved, setLastSaved] = useState("");

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
          setLastSaved("");
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
        aria-label={app ? "Edit application" : "Log an application"}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
      >
        <form
          ref={formRef}
          action={async (fd) => {
            await saveApplication(fd);
            if (app) {
              dialogRef.current?.close();
              return;
            }
            formRef.current?.reset();
            if (fd.get("another")) {
              setLastSaved(String(fd.get("company") ?? ""));
              formRef.current?.scrollTo(0, 0);
              formRef.current
                ?.querySelector<HTMLInputElement>("input[name=company]")
                ?.focus();
            } else {
              dialogRef.current?.close();
            }
          }}
        >
          <h2>{app ? "Edit application" : "Log an application"}</h2>
          {lastSaved ? (
            <p className="modal-hint saved" role="status">
              Logged {lastSaved}. Next one:
            </p>
          ) : (
            <p className="modal-hint">
              {app
                ? "Yours to correct. Nothing here is overwritten by a refresh."
                : "For roles you applied to outside the board: an HR form from a LinkedIn post, a referral, a DM."}
            </p>
          )}

          {app && <input type="hidden" name="id" value={app.id} />}

          <div className="modal-grid">
            <label className="field">
              <span>Company</span>
              <input
                name="company"
                required
                autoComplete="off"
                placeholder="Razorpay"
                defaultValue={app?.company ?? ""}
              />
            </label>

            <label className="field">
              <span>Role</span>
              <input
                name="title"
                required
                autoComplete="off"
                placeholder="Backend Engineer"
                defaultValue={app?.title ?? ""}
              />
            </label>
          </div>

          {/* How you applied, which is not where you found it: a Greenhouse
              role can still go in through the recruiter. Editable on every row,
              scraped or not, because the board can't know which door you used. */}
          <label className="field">
            <span>Applied through</span>
            <select
              name="channel"
              defaultValue={app?.channel ?? (sourceEditable ? CHANNELS[0].key : "ats")}
            >
              {CHANNELS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

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

            <label className="check field-check">
              <input
                type="checkbox"
                name="shortlisted"
                defaultChecked={Boolean(app?.shortlistedAt)}
              />
              <span>
                Shortlisted
                <em>Call, interview or assignment, even if it ended in a no</em>
              </span>
            </label>
          </div>

          {/* Tells the action that an empty date means "clear it", not "leave it". */}
          <input type="hidden" name="hadResponse" value={hadResponse ? "1" : ""} />

          <label className="field">
            <span>Link</span>
            <input
              name="url"
              type="url"
              autoComplete="off"
              placeholder="LinkedIn post or form URL"
              defaultValue={app?.url ?? ""}
            />
          </label>

          <label className="field">
            <span>Notes</span>
            <textarea
              name="notes"
              rows={2}
              placeholder="Recruiter name, who referred you, salary discussed"
              defaultValue={app?.notes ?? ""}
            />
          </label>

          {/* Closed by default, but its fields still submit: a closed <details>
              hides its inputs, it doesn't remove them from the form. */}
          <details className="more">
            <summary>More details</summary>
            <div className="more-body">
              <div className="modal-grid">
                <label className="field">
                  <span>Found on</span>
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
              </div>

              <div className="modal-grid">
                <label className="field">
                  <span>Location</span>
                  <input
                    name="location"
                    autoComplete="off"
                    placeholder="Bengaluru"
                    defaultValue={app?.location ?? ""}
                  />
                </label>

                <label className="check field-check">
                  <input
                    type="checkbox"
                    name="remote"
                    defaultChecked={app?.remote ?? false}
                  />
                  <span>Remote</span>
                </label>
              </div>
            </div>
          </details>

          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => dialogRef.current?.close()}
            >
              {lastSaved ? "Done" : "Cancel"}
            </button>
            {!app && (
              <SubmitButton
                className="btn ghost"
                name="another"
                value="1"
                pendingText={pendingText}
              >
                Save &amp; add another
              </SubmitButton>
            )}
            <SubmitButton pendingText={pendingText}>
              {app ? "Save" : "Log it"}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
