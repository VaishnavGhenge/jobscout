"use client";

import { setStatus } from "../actions";
import type { ApplicationStatus } from "@/db/schema";

export const STATUS_OPTIONS: { key: ApplicationStatus; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "applied", label: "Applied" },
  { key: "interviewing", label: "Interviewing" },
  { key: "offer", label: "Offer" },
  { key: "rejected", label: "Rejected" },
];

export function StatusSelect({
  id,
  status,
  label,
}: {
  id: number;
  status: ApplicationStatus;
  /** Every card renders one of these, so the select needs to say whose it is. */
  label: string;
}) {
  return (
    <form action={setStatus}>
      <input type="hidden" name="id" value={id} />
      <select
        name="status"
        aria-label={label}
        defaultValue={status}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {STATUS_OPTIONS.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
    </form>
  );
}
