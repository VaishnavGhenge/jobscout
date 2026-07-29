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
}: {
  id: number;
  status: ApplicationStatus;
}) {
  return (
    <form action={setStatus}>
      <input type="hidden" name="id" value={id} />
      <select
        name="status"
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
