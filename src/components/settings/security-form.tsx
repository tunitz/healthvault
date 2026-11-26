"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Settings → Security. Immediate password change: confirms the current password, rotates the
 * session secret server-side, and renews this session in place. Other sessions are invalidated. */
export function SecurityForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError("New passwords do not match");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirm }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        const message = typeof body?.error === "string" ? body.error : "Could not change password";
        setError(message);
        toast.error("Password not changed", { description: message });
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      toast.success("Password updated — other sessions signed out");
    } catch {
      setError("Could not reach the server");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>Current password</span>
        <Input
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>New password</span>
        <Input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>Confirm new password</span>
        <Input
          type="password"
          name="confirm"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          disabled={pending}
        />
      </label>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Updating…" : "Change password"}
      </Button>
    </form>
  );
}
