/**
 * First boot: no env credentials and no stored credentials. Boot must not throw, setup/health must
 * work, and every other page/API must funnel to setup. Isolated scratch DB via the test preload.
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { getAuthState } from "@/lib/auth-config";
import { register } from "@/instrumentation";
import { proxy } from "@/proxy";

delete process.env.HEALTHVAULT_PASSWORD_HASH;
delete process.env.HEALTHVAULT_SESSION_SECRET;

function request(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3040${path}`, {
    headers: { host: "127.0.0.1:3040" },
  });
}

function passed(response: Response): boolean {
  return response.status === 200 && response.headers.get("x-middleware-next") === "1";
}

describe("first boot, unconfigured", () => {
  test("reports the unconfigured state", () => {
    expect(getAuthState()).toBe("unconfigured");
  });

  test("boot does not fail when credentials are absent", async () => {
    await expect(register()).resolves.toBeUndefined();
  });

  test("setup, login and the health probe stay reachable", () => {
    for (const path of ["/setup", "/login", "/api/health"]) {
      expect(passed(proxy(request(path))), path).toBe(true);
    }
  });

  test("other pages redirect to setup", () => {
    for (const path of ["/", "/nutrition", "/settings"]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(307);
      expect(response.headers.get("location"), path).toContain("/setup");
    }
  });

  test("other APIs answer 503 with a clear setup-required message", async () => {
    for (const path of ["/api/type-stats", "/api/agent/healthvault_context", "/api/settings"]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(503);
      const body = await response.json();
      expect(body.setupRequired).toBe(true);
      expect(String(body.error)).toContain("setup required");
    }
  });
});
