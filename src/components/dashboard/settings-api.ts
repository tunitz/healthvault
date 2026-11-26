/**
 * Shared client-side helpers for the versioned settings API. Session + Origin protected;
 * a stale revision returns 409 and must never silently overwrite another device's changes.
 */
import type { AppSettings, SettingsSnapshot } from "@/lib/services/settings";

export const CONFLICT_MESSAGE =
  "Settings changed on another device — reload to review the latest preferences.";

export class ConflictError extends Error {
  constructor(message = CONFLICT_MESSAGE) {
    super(message);
    this.name = "ConflictError";
  }
}

export async function fetchSettings(): Promise<SettingsSnapshot> {
  const response = await fetch("/api/settings", { cache: "no-store" });
  const body = (await response.json().catch(() => null)) as (SettingsSnapshot & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(body?.error ?? "Could not load settings");
  }
  return body as SettingsSnapshot;
}

async function parse(response: Response): Promise<SettingsSnapshot> {
  const body = (await response.json().catch(() => null)) as (SettingsSnapshot & { error?: string }) | null;
  if (response.status === 409) throw new ConflictError(CONFLICT_MESSAGE);
  if (!response.ok) throw new Error(body?.error ?? "Could not save settings");
  return body as SettingsSnapshot;
}

/** Replace the whole settings object with an optimistic-revision check. */
export async function saveSettings(value: AppSettings, revision: number): Promise<SettingsSnapshot> {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, revision }),
  });
  return parse(response);
}

/**
 * Restore one section to defaults without wiping the other section. The API only offers a whole
 * object reset, so we read the current value, replace just this section, and PUT with the same
 * revision guard.
 */
export async function resetSection(
  current: AppSettings,
  revision: number,
  section: "appearance" | "dashboard",
  defaults: AppSettings,
): Promise<SettingsSnapshot> {
  const value: AppSettings = { ...current, [section]: defaults[section] };
  return saveSettings(value, revision);
}

/** Human-readable error text, with a distinct branch for the 409 conflict. */
export function errorMessage(error: unknown): string {
  if (error instanceof ConflictError) return error.message;
  if (error instanceof Error) return error.message;
  return "Could not save settings";
}
