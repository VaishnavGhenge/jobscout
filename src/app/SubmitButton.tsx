"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit button that shows a spinner + disables itself while its parent <form>'s
 * server action is in flight. Must be rendered inside the <form> it submits.
 */
export function SubmitButton({
  children,
  pendingText,
  className = "btn",
  title,
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className={className}
      type="submit"
      disabled={pending}
      aria-busy={pending}
      title={title}
    >
      {pending && <span className="spinner" aria-hidden="true" />}
      {pending ? (pendingText ?? children) : children}
    </button>
  );
}
