import { SubmitButton } from "./SubmitButton";

const REASONS: { value: string; label: string; hint: string }[] = [
  { value: "stack", label: "Wrong stack", hint: "Not the technology you work in" },
  { value: "level", label: "Wrong level", hint: "Too senior or too junior for you" },
  { value: "domain", label: "Wrong domain", hint: "Mobile, ML, data, embedded" },
  { value: "location", label: "Location", hint: "Not somewhere you can work" },
  { value: "pay", label: "Pay", hint: "Band is too low" },
  { value: "company", label: "Company", hint: "Not an employer you want" },
  { value: "other", label: "Other", hint: "No particular reason" },
];

/**
 * Dismiss a role, and say why.
 *
 * The reason is the whole reason this is a menu rather than a button. A bare
 * dismissal records that you said no and nothing else, which is why one
 * dismissal existed against a board where the top-scoring role was a C#/Angular
 * job: the ranking had been overruled and had no way to know it. Each option
 * here maps onto a specific lever in profile.ts, so "wrong stack" three times in
 * a week is a concrete instruction about `offStackTech` rather than a vague sense
 * that the board is off.
 *
 * Built on `<details>` so it works without client JavaScript, like every other
 * control on this page.
 */
export function DismissMenu({
  action,
  source,
  externalId,
  company,
  title,
  score,
}: {
  action: (formData: FormData) => Promise<void>;
  source: string;
  externalId: string;
  company: string;
  title: string;
  score: number;
}) {
  return (
    <details className="dismiss-menu">
      <summary
        className="btn ghost small dismiss"
        title="Rule this out. It won't come back on the next refresh."
      >
        ✕ Not for me
      </summary>
      <div className="dismiss-options">
        <p className="micro">Why?</p>
        {REASONS.map((r) => (
          <form action={action} key={r.value}>
            <input type="hidden" name="source" value={source} />
            <input type="hidden" name="externalId" value={externalId} />
            <input type="hidden" name="company" value={company} />
            <input type="hidden" name="title" value={title} />
            <input type="hidden" name="score" value={score} />
            <input type="hidden" name="reason" value={r.value} />
            <SubmitButton
              className="btn ghost small wide"
              pendingText="…"
              title={r.hint}
            >
              {r.label}
            </SubmitButton>
          </form>
        ))}
      </div>
    </details>
  );
}
