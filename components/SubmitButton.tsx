'use client';

import { useFormStatus } from 'react-dom';

/** A form button that shows it's working (server actions can take a few seconds). */
export function SubmitButton({
  children,
  pendingText,
  className,
  confirmText,
}: {
  children: React.ReactNode;
  pendingText: string;
  className?: string;
  /** If set, asks "are you sure?" first (for destructive actions). */
  confirmText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
      className={`${className ?? ''} disabled:opacity-60`}
    >
      {pending ? pendingText : children}
    </button>
  );
}
