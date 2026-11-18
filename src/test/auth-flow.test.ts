/**
 * UI-first setup and immediate password change on a scratch DB: single initialization, concurrent
 * setup guard, wrong-current rejection, session rotation, and stored-over-env precedence.
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  CredentialConflictError,
  getAuthState,
  getStoredCredentials,
  invalidateEnvConfigCache,
  persistStoredCredentials,
} from "@/lib/auth-config";
import { setupPassword, changePassword, AuthFlowError, MIN_PASSWORD_LENGTH } from "@/lib/auth-flow";
import { crossOriginFailure, hashPassword, signSession, verifyPassword, verifySession } from "@/lib/auth";
import { POST as setupRoute } from "@/app/api/auth/setup/route";
import { sqlite } from "@/db";

delete process.env.HEALTHVAULT_PASSWORD_HASH;
delete process.env.HEALTHVAULT_SESSION_SECRET;
invalidateEnvConfigCache();

const FIRST = "first-password-123";
const SECOND = "second-password-456";

function jsonPost(path: string, body: Record<string, unknown>): Request {
  return new NextRequest(`http://127.0.0.1:3040${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3040", origin: "http://127.0.0.1:3040", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("UI-first setup and password change", () => {
  test("cross-origin writes are rejected, same-origin writes pass", () => {
    const cross = new NextRequest("http://127.0.0.1:3040/api/auth/setup", {
      method: "POST",
      headers: { host: "127.0.0.1:3040", origin: "https://attacker.example" },
    });
    expect(crossOriginFailure(cross)).toEqual({ status: 403, error: "cross-origin request rejected" });
    expect(crossOriginFailure(jsonPost("/api/auth/setup", { password: FIRST, confirm: FIRST }))).toBeNull();
  });

  test("setup succeeds once, sets a working session, then closes", async () => {
    const { token } = setupPassword(FIRST, FIRST);
    expect(getAuthState()).toBe("stored");
    expect(getStoredCredentials()?.active).toBe(true);
    expect(verifyPassword(FIRST)).toBe(true);
    expect(verifySession(token)).toBe(true);

    // A second attempt is refused both in the service and at the route.
    expect(() => setupPassword(SECOND, SECOND)).toThrow(AuthFlowError);
    const response = await setupRoute(jsonPost("/api/auth/setup", { password: SECOND, confirm: SECOND }));
    expect(response.status).toBe(409);
    expect(verifyPassword(FIRST)).toBe(true); // the original password was not overwritten
  });

  test("concurrent/second persistence cannot overwrite established credentials", () => {
    const before = getStoredCredentials()!;
    expect(() =>
      persistStoredCredentials("setup", {
        passwordHash: hashPassword(SECOND + "-race"),
        sessionSecret: "race-secret-not-used".padEnd(64, "x"),
      }),
    ).toThrow(CredentialConflictError);
    const after = getStoredCredentials()!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.updatedAtMs).toBe(before.updatedAtMs);
  });

  test("rejects a too-short or mismatched password", () => {
    expect(() => setupPassword("short", "short")).toThrow();
    expect(() => changePassword(FIRST, SECOND, "different")).toThrow();
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });

  test("password change with the wrong current password fails without changing anything", () => {
    const before = getStoredCredentials()!;
    expect(() => changePassword("not-the-current-password", SECOND, SECOND)).toThrow(AuthFlowError);
    const after = getStoredCredentials()!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(verifyPassword(FIRST)).toBe(true);
  });

  test("password change invalidates old sessions and renews the current session", () => {
    // A fresh session signed with the pre-change secret represents the current user.
    const current = signSession();
    expect(verifySession(current)).toBe(true);

    const { token: renewed } = changePassword(FIRST, SECOND, SECOND);
    expect(verifyPassword(SECOND)).toBe(true);
    expect(verifyPassword(FIRST)).toBe(false);
    expect(verifySession(current)).toBe(false); // old secret rotated away
    expect(verifySession(renewed)).toBe(true); // current user stays signed in
  });

  test("stored credentials win over env credentials once written", () => {
    process.env.HEALTHVAULT_PASSWORD_HASH = hashPassword("env-should-not-win");
    process.env.HEALTHVAULT_SESSION_SECRET = "abcdef0123456789abcdef0123456789";
    invalidateEnvConfigCache();
    expect(getAuthState()).toBe("stored");
    expect(verifyPassword(SECOND)).toBe(true);
    expect(verifyPassword("env-should-not-win")).toBe(false);
    // Leave the process env clean for other suites that share this worker pool.
    delete process.env.HEALTHVAULT_PASSWORD_HASH;
    delete process.env.HEALTHVAULT_SESSION_SECRET;
    invalidateEnvConfigCache();
  });

  test("corrupt stored hash never matches and never crashes", () => {
    sqlite.prepare("UPDATE auth_credentials SET password_hash = ? WHERE id = 1").run("not-a-hash");
    expect(verifyPassword("anything")).toBe(false);
  });
});
