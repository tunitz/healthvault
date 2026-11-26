/**
 * Settings-managed harness token on a scratch DB: token shape, stored-over-env precedence,
 * rotation invalidation, the concurrent-rotation CAS conflict, and legacy-env migration.
 * No live data and no secrets in logs — every value here is a disposable test value.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { sqlite } from "@/db";
import { agentRequestFailure, hashPassword } from "@/lib/auth";
import {
  CredentialConflictError,
  getActiveAuthConfig,
  getAuthState,
  getStoredCredentials,
  invalidateEnvConfigCache,
  persistStoredCredentials,
  storeAgentToken,
} from "@/lib/auth-config";
import { getAgentTokenState, rotateAgentToken } from "@/lib/services/agent-token";

const ENV_SECRET = "0123456789abcdef0123456789abcdef";
const ENV_TOKEN = "a".repeat(64);
const ENV_HASH = hashPassword("agent-token-env-password");

function bearerRequest(token: string): NextRequest {
  return new NextRequest("http://127.0.0.1:3040/api/mcp", {
    headers: {
      host: "127.0.0.1:3040",
      origin: "http://127.0.0.1:3040",
      authorization: `Bearer ${token}`,
    },
  });
}

beforeEach(() => {
  sqlite.prepare("DELETE FROM auth_credentials").run();
  process.env.HEALTHVAULT_PASSWORD_HASH = ENV_HASH;
  process.env.HEALTHVAULT_SESSION_SECRET = ENV_SECRET;
  process.env.HEALTHVAULT_API_TOKEN = ENV_TOKEN;
  delete process.env.HEALTHVAULT_API_TOKEN_FILE;
  process.env.HEALTHVAULT_ALLOWED_HOSTS = "127.0.0.1,localhost";
  invalidateEnvConfigCache();
});

describe("settings-managed harness token", () => {
  test("rotation generates a 32-byte (64 hex char) token stored in Settings", () => {
    const { token, source } = rotateAgentToken();
    expect(source).toBe("stored");
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(getStoredCredentials()?.agentToken).toBe(token);
  });

  test("env token is reported as the source until a stored token exists", () => {
    expect(getAgentTokenState()).toEqual({ token: ENV_TOKEN, source: "env" });
  });

  test("a stored token wins over the env token", () => {
    const { token } = rotateAgentToken();
    expect(getActiveAuthConfig().agentToken).toBe(token);
    expect(getActiveAuthConfig().agentToken).not.toBe(ENV_TOKEN);
    expect(getAgentTokenState()).toEqual({ token, source: "stored" });
  });

  test("rotation changes the value and the old token no longer resolves", () => {
    const first = rotateAgentToken().token;
    const second = rotateAgentToken().token;
    expect(second).not.toBe(first);
    expect(getActiveAuthConfig().agentToken).toBe(second);
    expect(getActiveAuthConfig().agentToken).not.toBe(first);
    expect(getAgentTokenState().token).toBe(second);
    // The old bearer no longer authenticates; the new one does.
    expect(agentRequestFailure(bearerRequest(first))).toEqual({
      status: 401,
      error: "authentication required",
    });
    expect(agentRequestFailure(bearerRequest(second))).toBeNull();
  });

  test("concurrent rotation is rejected by the CAS with a clear conflict", () => {
    rotateAgentToken();
    const staleRevision = getStoredCredentials()!.updatedAtMs;
    // A competing rotation lands first and bumps the revision.
    const winner = "b".repeat(64);
    storeAgentToken(winner, staleRevision);
    // The stale rotator must not overwrite the winner.
    expect(() => storeAgentToken("c".repeat(64), staleRevision)).toThrow(CredentialConflictError);
    expect(() => storeAgentToken("c".repeat(64), staleRevision)).toThrow(/changed|concurrent|reload/i);
    expect(getActiveAuthConfig().agentToken).toBe(winner);
  });

  test("first rotation migrates a legacy env install, preserving its password and session", () => {
    expect(getStoredCredentials()).toBeNull();
    expect(getAuthState()).toBe("legacy");
    expect(getAgentTokenState()).toEqual({ token: ENV_TOKEN, source: "env" });

    const { token, source } = rotateAgentToken();
    const stored = getStoredCredentials()!;
    expect(source).toBe("stored");
    expect(stored.active).toBe(true);
    expect(stored.passwordHash).toBe(ENV_HASH);
    expect(stored.sessionSecret).toBe(ENV_SECRET);
    expect(stored.agentToken).toBe(token);

    // Stored credentials are now authoritative; the old env token no longer resolves.
    expect(getAuthState()).toBe("stored");
    expect(getActiveAuthConfig().agentToken).toBe(token);
    expect(getActiveAuthConfig().agentToken).not.toBe(ENV_TOKEN);
  });

  test("no token anywhere reports a null source", () => {
    delete process.env.HEALTHVAULT_API_TOKEN;
    invalidateEnvConfigCache();
    expect(getAgentTokenState()).toEqual({ token: null, source: null });
  });

  test("a password change preserves the stored token", () => {
    const token = rotateAgentToken().token;
    const before = getStoredCredentials()!;
    persistStoredCredentials("change", {
      passwordHash: hashPassword("agent-token-new-password"),
      sessionSecret: "f".repeat(64),
      expectedUpdatedAtMs: before.updatedAtMs,
    });
    const after = getStoredCredentials()!;
    expect(after.updatedAtMs).toBeGreaterThan(before.updatedAtMs);
    expect(after.agentToken).toBe(token);
  });
});
