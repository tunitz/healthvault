import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "./server";
import { INSTRUCTIONS } from "./mcp";
import { INSTRUCTIONS as SHARED_INSTRUCTIONS } from "./definitions";

type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function mockFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}

describe("HealthVault MCP instructions", () => {
  test("does not tell the agent to call context unconditionally at session start", () => {
    expect(INSTRUCTIONS.toLowerCase()).not.toContain("start every session");
    expect(INSTRUCTIONS.toLowerCase()).not.toContain("start each session");
  });

  test("makes context conditional on the question needing stored data", () => {
    expect(INSTRUCTIONS).toContain("only when the user asks a question that needs stored HealthVault data");
    expect(INSTRUCTIONS).toContain("do not call it for greetings");
    expect(INSTRUCTIONS).toContain("optional `sections` array");
  });

  test("stdio and shared definitions expose identical instructions", () => {
    expect(INSTRUCTIONS).toBe(SHARED_INSTRUCTIONS);
  });
});

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

  test("an explicit token option avoids env/token-file resolution", async () => {
    const previousToken = process.env.HEALTHVAULT_TOKEN;
    const previousTokenFile = process.env.HEALTHVAULT_TOKEN_FILE;
    delete process.env.HEALTHVAULT_TOKEN;
    delete process.env.HEALTHVAULT_TOKEN_FILE;
    const authorization: string[] = [];
    try {
      const server = createServer({
        token: "in-app-transport-placeholder",
        fetchImpl: mockFetch(async (_input, init) => {
          authorization.push(new Headers(init?.headers).get("authorization") ?? "");
          return new Response(JSON.stringify({ ok: true, result: {} }), {
            headers: { "content-type": "application/json" },
          });
        }),
      });
      await server.request("healthvault_context");
      expect(authorization).toEqual(["Bearer in-app-transport-placeholder"]);
    } finally {
      if (previousToken === undefined) delete process.env.HEALTHVAULT_TOKEN;
      else process.env.HEALTHVAULT_TOKEN = previousToken;
      if (previousTokenFile === undefined) delete process.env.HEALTHVAULT_TOKEN_FILE;
      else process.env.HEALTHVAULT_TOKEN_FILE = previousTokenFile;
    }
  });
});
