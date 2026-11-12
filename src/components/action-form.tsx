"use client";

import * as React from "react";
import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActionState } from "@/lib/action-state";

export type ActionFn = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function SubmitButton({
  children,
  className,
  pendingLabel = "Working…",
  ...props
}: React.ComponentProps<typeof Button> & { pendingLabel?: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      aria-busy={pending}
      {...props}
      disabled={pending || props.disabled}
      className={className}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}

/**
 * A normal form wired to a server action. Validation errors from the service layer are
 * rendered in place, so a bad value never takes the page down.
 */
export function ActionForm({
  action,
  className,
  children,
  resetOnSuccess = false,
  confirm,
  onSuccess,
}: {
  action: ActionFn;
  className?: string;
  children: React.ReactNode;
  resetOnSuccess?: boolean;
  /** Hard deletes have no undo, so the browser asks before the action runs. */
  confirm?: string;
  /** Called once per successful result, so a parent can clear a sibling form's stale state. */
  onSuccess?: (state: ActionState) => void;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, { ok: true });
  const ref = useRef<HTMLFormElement>(null);
  const handledState = useRef<ActionState | null>(null);

  useEffect(() => {
    if (resetOnSuccess && state.ok && state.message) ref.current?.reset();
  }, [state, resetOnSuccess]);

  useEffect(() => {
    if (state === handledState.current) return;
    handledState.current = state;
    if (state.ok && state.message) onSuccess?.(state);
  }, [state, onSuccess]);

  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {children}
      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", className)}>
      <span>{label}</span>
      {children}
      {hint ? <span className="text-[11px]">{hint}</span> : null}
    </label>
  );
}
