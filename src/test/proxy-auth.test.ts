/**
 * Proxy auth regression: the agent API requires a token or session and rejects untrusted
 * Host/Origin headers. Pure request/response checks — no server, no database.
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { hashPassword, signSession } from "@/lib/auth";
import { proxy } from "@/proxy";

const SECRET = "0123456789abcdef0123456789abcdef";

process.env.HEALTHVAULT_PASSWORD_HASH = hashPassword("proxy-test-password");
process.env.HEALTHVAULT_SESSION_SECRET = SECRET;
process.env.HEALTHVAULT_API_TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
delete process.env.HEALTHVAULT_API_TOKEN_FILE;
process.env.HEALTHVAULT_ALLOWED_HOSTS = "127.0.0.1,localhost";

function request(
  path: string,
  options: { cookie?: string; token?: string; host?: string; origin?: string } = {},
): NextRequest {
  const headers = new Headers();
  headers.set("host", options.host ?? "127.0.0.1:3040");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.host) headers.set("host", options.host);
  if (options.origin) headers.set("origin", options.origin);
  return new NextRequest(`http://127.0.0.1:3040${path}`, {
    headers,
  });
}

function isPassedThrough(response: Response): boolean {
  return response.status === 200 && response.headers.get("x-middleware-next") === "1";
}

describe("proxy auth", () => {
  test("the agent surface rejects requests without a token or session", async () => {
    for (const path of ["/api/agent", "/api/agent/healthvault_context"]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: "authentication required" });
    }
  });

  test("a bearer token authorizes the machine surface", () => {
    const response = proxy(
      request("/api/agent/healthvault_context", {
        token: process.env.HEALTHVAULT_API_TOKEN!,
      }),
    );
    expect(isPassedThrough(response)).toBe(true);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("an incorrect bearer token does not authorize the agent API", () => {
    expect(proxy(request("/api/agent", { token: "x".repeat(64) })).status).toBe(401);
  });

  test("the default IPv6 loopback hostname parses from the allowlist", () => {
    const previousAllowedHosts = process.env.HEALTHVAULT_ALLOWED_HOSTS;
    process.env.HEALTHVAULT_ALLOWED_HOSTS = "::1";
    try {
      const response = proxy(
        request("/api/agent", {
          token: process.env.HEALTHVAULT_API_TOKEN!,
          host: "[::1]:3040",
        }),
      );
      expect(isPassedThrough(response)).toBe(true);
    } finally {
      if (previousAllowedHosts === undefined) delete process.env.HEALTHVAULT_ALLOWED_HOSTS;
      else process.env.HEALTHVAULT_ALLOWED_HOSTS = previousAllowedHosts;
    }
  });

  test("a valid session still authorizes same-origin machine requests", () => {
    const response = proxy(
      request("/api/agent", {
        cookie: `hv_session=${signSession()}`,
        origin: "http://127.0.0.1:3040",
      }),
    );
    expect(isPassedThrough(response)).toBe(true);
  });

  test("DNS-rebinding Host and mismatched Origin are rejected", async () => {
    const token = process.env.HEALTHVAULT_API_TOKEN!;
    const wrongHost = proxy(request("/api/agent", { token, host: "attacker.example" }));
    expect(wrongHost.status).toBe(403);
    expect(await wrongHost.json()).toEqual({ error: "untrusted host" });

    const wrongOrigin = proxy(request("/api/agent", { token, origin: "https://attacker.example" }));
    expect(wrongOrigin.status).toBe(403);
    expect(await wrongOrigin.json()).toEqual({ error: "cross-origin request rejected" });
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
      expect(isPassedThrough(proxy(request(path, { cookie }))), path).toBe(true);
    }
  });

  test("a forged session cookie does not pass the gate", () => {
    const response = proxy(request("/api/type-stats", { cookie: "hv_session=v1.9999999999.deadbeef" }));
    expect(response.status).toBe(401);
  });
});
