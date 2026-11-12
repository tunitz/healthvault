import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "./server";

type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function mockFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}

describe("HealthVault MCP HTTP authentication", () => {
  test("sends the configured bearer token with tool requests", async () => {
    const previousToken = process.env.HEALTHVAULT_TOKEN;
    const previousTokenFile = process.env.HEALTHVAULT_TOKEN_FILE;
    const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    delete process.env.HEALTHVAULT_TOKEN_FILE;
    process.env.HEALTHVAULT_TOKEN = token;

    const authorization: string[] = [];
    try {
      const server = createServer({
        fetchImpl: mockFetch(async (_input, init) => {
          authorization.push(new Headers(init?.headers).get("authorization") ?? "");
          return new Response(JSON.stringify({ ok: true, result: { today: "2026-11-13" } }), {
            headers: { "content-type": "application/json" },
          });
        }),
      });

      await server.request("healthvault_context");
      expect(authorization).toEqual([`Bearer ${token}`]);
    } finally {
      if (previousToken === undefined) delete process.env.HEALTHVAULT_TOKEN;
      else process.env.HEALTHVAULT_TOKEN = previousToken;
      if (previousTokenFile === undefined) delete process.env.HEALTHVAULT_TOKEN_FILE;
      else process.env.HEALTHVAULT_TOKEN_FILE = previousTokenFile;
    }
  });

  test("reads the bearer token from an owner-only file", async () => {
    const previousToken = process.env.HEALTHVAULT_TOKEN;
    const previousTokenFile = process.env.HEALTHVAULT_TOKEN_FILE;
    const directory = mkdtempSync(join("/tmp/opencode", "healthvault-mcp-token-test-"));
    const tokenFile = join(directory, "agent.token");
    const token = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    delete process.env.HEALTHVAULT_TOKEN;
    process.env.HEALTHVAULT_TOKEN_FILE = tokenFile;

    const authorization: string[] = [];
    try {
      const server = createServer({
        fetchImpl: mockFetch(async (_input, init) => {
          authorization.push(new Headers(init?.headers).get("authorization") ?? "");
          return new Response(JSON.stringify({ ok: true, result: {} }), {
            headers: { "content-type": "application/json" },
          });
        }),
      });
      await server.request("healthvault_context");
      expect(authorization).toEqual([`Bearer ${token}`]);
    } finally {
      if (previousToken === undefined) delete process.env.HEALTHVAULT_TOKEN;
      else process.env.HEALTHVAULT_TOKEN = previousToken;
      if (previousTokenFile === undefined) delete process.env.HEALTHVAULT_TOKEN_FILE;
      else process.env.HEALTHVAULT_TOKEN_FILE = previousTokenFile;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
