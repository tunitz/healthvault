import {
  CredentialConflictError,
  getAuthState,
  getStoredCredentials,
  newSessionSecret,
  persistStoredCredentials,
} from "@/lib/auth-config";
import { hashPassword, signSession, verifyPassword } from "@/lib/auth";
import { ValidationError, fail } from "@/lib/validate";

/** UI passwords must be at least this long; setup and change enforce the same floor. */
export const MIN_PASSWORD_LENGTH = 8;

/** An error safe to show in the form; `status` maps to the HTTP response. */
export class AuthFlowError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AuthFlowError";
    this.status = status;
  }
}

/** Validate and confirm a new password. Never log or return the password itself. */
export function checkNewPassword(password: unknown, confirm?: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (confirm !== undefined && confirm !== password) fail("Passwords do not match");
  return password;
}

/**
 * First-run setup. Allowed exactly once: UNCONFIGURED (no env and no stored credentials). The
 * database CAS in persistStoredCredentials is the real guard against concurrent/second attempts —
 * this state check is only a fast, friendly pre-check. Returns the new session cookie value.
 */
export function setupPassword(passwordInput: unknown, confirm?: unknown): { token: string } {
  const password = checkNewPassword(passwordInput, confirm);
  if (getAuthState() !== "unconfigured") {
    throw new AuthFlowError("HealthVault is already set up", 409);
  }
  const stored = persistStoredCredentials("setup", {
    passwordHash: hashPassword(password),
    sessionSecret: newSessionSecret(),
  });
  // signSession re-reads active credentials, so it uses the secret just written.
  void stored;
  return { token: signSession() };
}

/**
 * Immediate password change for a signed-in user. Verifies the current password against the
 * active (stored or legacy env) credentials, then rotates BOTH the hash and the session secret.
 * Rotating the secret invalidates every other session cookie; the returned token re-authenticates
 * the current one, so the UI renews in place with no restart or redirect to login.
 */
export function changePassword(
  currentPassword: unknown,
  newPasswordInput: unknown,
  confirm?: unknown,
): { token: string } {
  const newPassword = checkNewPassword(newPasswordInput, confirm);
  if (typeof currentPassword !== "string" || !currentPassword) {
    throw new AuthFlowError("Current password is required");
  }
  if (!verifyPassword(currentPassword)) {
    throw new AuthFlowError("Current password is incorrect", 401);
  }

  const active = getStoredCredentials();
  const persist =
    active?.active === true
      ? persistStoredCredentials("change", {
          passwordHash: hashPassword(newPassword),
          sessionSecret: newSessionSecret(),
          expectedUpdatedAtMs: active.updatedAtMs,
        })
      : // LEGACY install: first migration to stored credentials, no active row to CAS against.
        persistStoredCredentials("change", {
          passwordHash: hashPassword(newPassword),
          sessionSecret: newSessionSecret(),
          expectedUpdatedAtMs: 0,
        });
  void persist;
  return { token: signSession() };
}

/** Map service-layer errors to an HTTP status; unknown errors stay 500. */
export function authFlowStatus(error: unknown): number {
  if (error instanceof AuthFlowError) return error.status;
  if (error instanceof ValidationError) return error.status;
  if (error instanceof CredentialConflictError) return 409;
  return 500;
}

/** Map service-layer errors to a caller-safe message (never a secret or stack). */
export function authFlowMessage(error: unknown): string {
  if (error instanceof Error && (error instanceof AuthFlowError || error instanceof ValidationError || error instanceof CredentialConflictError)) {
    return error.message;
  }
  return "Could not update credentials";
}
