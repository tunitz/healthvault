/**
 * Legacy installs: env credentials are the only ones configured, and must authenticate exactly as
 * before, with no stored credentials and no redirect to setup.
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { hashPassword, signSession, verifyPassword, verifySession } from "@/lib/auth";
import { getAuthState, getStoredCredentials, invalidateEnvConfigCache } from "@/lib/auth-config";
import { proxy } from "@/proxy";

process.env.HEALTHVAULT_PASSWORD_HASH = hashPassword("legacy-env-password");
process.env.HEALTHVAULT_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
delete process.env.HEALTHVAULT_API_TOKEN_FILE;
process.env.HEALTHVAULT_API_TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
process.env.HEALTHVAULT_ALLOWED_HOSTS = "127.0.0.1,localhost";
invalidateEnvConfigCache();

describe("legacy env credentials", () => {
  test("remain the active source when no stored credentials exist", () => {
    expect(getStoredCredentials()).toBeNull();
    expect(getAuthState()).toBe("legacy");
  });

  test("still authenticate the password and sign valid sessions", () => {
    expect(verifyPassword("legacy-env-password")).toBe(true);
    expect(verifyPassword("wrong-password")).toBe(false);
    const token = signSession();
    expect(verifySession(token)).toBe(true);
    expect(verifySession("v1.9999999999.deadbeef")).toBe(false);
  });

  test("a valid session passes the proxy gate (no setup redirect)", () => {
    const request = new NextRequest("http://127.0.0.1:3040/nutrition", {
      headers: { host: "127.0.0.1:3040", cookie: `hv_session=${signSession()}` },
    });
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("unauthenticated pages still go to login, not setup", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3040/nutrition", { headers: { host: "127.0.0.1:3040" } }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });
});
