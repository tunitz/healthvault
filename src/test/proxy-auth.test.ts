/**
 * Proxy auth regression: `/api/agent/*` stays reachable with no credential, while every page and
 * other API route keeps its session gate. Pure request/response checks — no server, no database.
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { hashPassword, signSession } from "@/lib/auth";
import { proxy } from "@/proxy";

const SECRET = "0123456789abcdef0123456789abcdef";

process.env.HEALTHVAULT_PASSWORD_HASH = hashPassword("proxy-test-password");
process.env.HEALTHVAULT_SESSION_SECRET = SECRET;

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3040${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

function isPassedThrough(response: Response): boolean {
  return response.status === 200 && response.headers.get("x-middleware-next") === "1";
}

describe("proxy auth", () => {
  test("the agent surface passes through with no credential", () => {
    for (const path of ["/api/agent", "/api/agent/healthvault_context"]) {
      expect(isPassedThrough(proxy(request(path))), path).toBe(true);
    }
  });

  test("other API routes still require a session", async () => {
    const response = proxy(request("/api/type-stats"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication required" });
  });

  test("pages still redirect to login", () => {
    const response = proxy(request("/nutrition"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toEndWith("/login?next=%2Fnutrition");
  });

  test("a valid session cookie passes UI pages and other APIs", () => {
    const cookie = `hv_session=${signSession()}`;
    for (const path of ["/nutrition", "/api/type-stats"]) {
      expect(isPassedThrough(proxy(request(path, cookie))), path).toBe(true);
    }
  });

  test("a forged session cookie does not pass the gate", () => {
    const response = proxy(request("/api/type-stats", "hv_session=v1.9999999999.deadbeef"));
    expect(response.status).toBe(401);
  });
});
