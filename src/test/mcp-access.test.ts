/**
 * Stage 7: real MCP enable/LAN gating and the direct Streamable HTTP transport.
 * Scratch DB from the preload; credentials/token set in-process. No server, no live data.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { hashPassword, signSession } from "@/lib/auth";
import { invalidateEnvConfigCache } from "@/lib/auth-config";
import {
  defaultSettings,
  getSettings,
  updateSettings,
} from "@/lib/services/settings";
import {
  handleMcpRpc,
  isLocalPeer,
  mcpAccessFailure,
  mcpToolDefinitions,
} from "@/lib/services/mcp";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { proxy } from "@/proxy";
import { POST as agentPost } from "@/app/api/agent/[tool]/route";
import { POST as mcpPost } from "@/app/api/mcp/route";

const TOKEN = "mcp-stage7-secret-token-0123456789abcdef0123456789";
process.env.HEALTHVAULT_PASSWORD_HASH = hashPassword("mcp-stage7-password");
process.env.HEALTHVAULT_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.HEALTHVAULT_API_TOKEN = TOKEN;
delete process.env.HEALTHVAULT_API_TOKEN_FILE;
process.env.HEALTHVAULT_ALLOWED_HOSTS = "127.0.0.1,localhost";
delete process.env.HEALTHVAULT_TRUST_PROXY;
invalidateEnvConfigCache();

function setMcp(enabled: boolean, lanEnabled: boolean) {
  const next = defaultSettings();
  next.mcp = { enabled, lanEnabled };
  updateSettings(next, getSettings().revision);
}

function request(
  path: string,
  options: {
    body?: unknown;
    token?: boolean;
    cookie?: string;
    host?: string;
    origin?: string;
    xff?: string | null;
  } = {},
): NextRequest {
  const headers = new Headers({
    host: options.host ?? "127.0.0.1:3040",
    "content-type": "application/json",
  });
  if (options.token !== false) headers.set("authorization", `Bearer ${TOKEN}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.xff !== null) headers.set("x-forwarded-for", options.xff ?? "127.0.0.1");
  return new NextRequest(`http://127.0.0.1:3040${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

const rpc = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

afterEach(() => {
  setMcp(true, false);
  delete process.env.HEALTHVAULT_TRUST_PROXY;
});

describe("MCP access gate", () => {
  test("defaults keep local machine access enabled and LAN disabled", () => {
    expect(getSettings().value.mcp).toEqual({ enabled: true, lanEnabled: false });
  });

  test("disabled mode blocks the agent API and HTTP MCP", async () => {
    setMcp(false, false);
    const agent = await agentPost(request("/api/agent/healthvault_context"), {
      params: Promise.resolve({ tool: "healthvault_context" }),
    });
    expect(agent.status).toBe(403);
    expect(await agent.json()).toEqual({ error: "MCP is disabled" });

    const mcp = await mcpPost(request("/api/mcp", { body: rpc("tools/list") }));
    expect(mcp.status).toBe(403);
    expect(await mcp.json()).toEqual({ error: "MCP is disabled" });
  });

  test("enabled local access works on both transports", async () => {
    setMcp(true, false);
    const agent = await agentPost(request("/api/agent/healthvault_context"), {
      params: Promise.resolve({ tool: "healthvault_context" }),
    });
    expect(agent.status).toBe(200);

    const mcp = await mcpPost(request("/api/mcp", { body: rpc("ping") }));
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("bearer or session auth is required and Host/Origin are checked", async () => {
    setMcp(true, false);
    expect((await mcpPost(request("/api/mcp", { token: false, body: rpc("ping") }))).status).toBe(401);
    expect((await mcpPost(request("/api/mcp", { host: "attacker.example", body: rpc("ping") }))).status).toBe(403);
    expect((await mcpPost(request("/api/mcp", { origin: "https://attacker.example", body: rpc("ping") }))).status).toBe(403);
    expect(
      (await mcpPost(request("/api/mcp", { token: false, cookie: `hv_session=${signSession()}`, body: rpc("ping") }))).status,
    ).toBe(200);
  });

  test("LAN peers are blocked by default and allowed only when LAN is enabled", async () => {
    setMcp(true, false);
    const lanRequest = request("/api/mcp", { body: rpc("ping"), xff: "192.168.1.50" });
    expect(isLocalPeer(lanRequest)).toBe(false);
    expect(mcpAccessFailure(lanRequest)?.error).toContain("local-only");
    const blocked = await mcpPost(request("/api/mcp", { body: rpc("ping"), xff: "192.168.1.50" }));
    expect(blocked.status).toBe(403);

    setMcp(true, true);
    expect(mcpAccessFailure(lanRequest)).toBeNull();
    expect((await mcpPost(request("/api/mcp", { body: rpc("ping"), xff: "192.168.1.50" }))).status).toBe(200);
  });

  test("trusted-proxy mode reads the leftmost forwarded hop", () => {
    process.env.HEALTHVAULT_TRUST_PROXY = "1";
    const behindProxy = request("/api/mcp", { body: rpc("ping"), xff: "192.168.1.50, 127.0.0.1" });
    expect(isLocalPeer(behindProxy)).toBe(false);
    const localBehindProxy = request("/api/mcp", { body: rpc("ping"), xff: "127.0.0.1, 192.168.1.1" });
    expect(isLocalPeer(localBehindProxy)).toBe(true);
  });

  test("the proxy enforces the same gate but keeps /api/mcp/status reachable by session", () => {
    setMcp(true, false);
    expect(proxy(request("/api/mcp", { body: rpc("ping") })).status).toBe(200);
    setMcp(false, false);
    expect(proxy(request("/api/mcp", { body: rpc("ping") })).status).toBe(403);
    expect(proxy(request("/api/agent/healthvault_context")).status).toBe(403);
    const status = proxy(
      new NextRequest("http://127.0.0.1:3040/api/mcp/status", {
        headers: { host: "127.0.0.1:3040", cookie: `hv_session=${signSession()}`, origin: "http://127.0.0.1:3040" },
      }),
    );
    expect(status.status).toBe(200);
    expect(status.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("direct Streamable HTTP MCP methods", () => {
  test("initialize returns identity, capabilities and the conditional instructions", async () => {
    setMcp(true, false);
    const response = await mcpPost(request("/api/mcp", { body: rpc("initialize", { protocolVersion: "2025-06-18" }) }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result.serverInfo).toEqual({ name: "healthvault", version: "0.1.0" });
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(String(body.result.instructions)).toContain("do not call it for greetings");
  });

  test("notifications/initialized gets an empty 202 and no response body", async () => {
    const notification = new NextRequest("http://127.0.0.1:3040/api/mcp", {
      method: "POST",
      headers: { host: "127.0.0.1:3040", "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const response = await mcpPost(notification);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("tools/list serves all 38 contracts with stable names", () => {
    const names = mcpToolDefinitions().map((definition) => definition.name);
    expect(names).toHaveLength(38);
    const expected = AGENT_TOOLS.map((tool) =>
      tool.startsWith("healthvault_") ? tool : `healthvault_${tool}`,
    );
    expect(names).toEqual(expected);
  });

  test("tools/call dispatches to the agent tool map and maps failures to isError", async () => {
    setMcp(true, false);
    const ok = await mcpPost(
      request("/api/mcp", { body: rpc("tools/call", { name: "healthvault_uploads_recent", arguments: { limit: 1 } }) }),
    );
    const okBody = (await ok.json()) as { result: { content: { text: string }[] } };
    expect(Array.isArray(JSON.parse(okBody.result.content[0].text))).toBe(true);

    const unknown = await handleMcpRpc(rpc("tools/call", { name: "healthvault_nope" }));
    expect((unknown?.body.result as { isError: boolean }).isError).toBe(true);

    const invalid = await handleMcpRpc(
      rpc("tools/call", { name: "healthvault_nutrition_day", arguments: { day: "not-a-day" } }),
    );
    expect((invalid?.body.result as { isError: boolean }).isError).toBe(true);
  });

  test("responses never disclose the bearer token", async () => {
    setMcp(true, false);
    const response = await mcpPost(request("/api/mcp", { body: rpc("tools/list") }));
    expect(await response.text()).not.toContain(TOKEN);
    setMcp(false, false);
    const disabled = await mcpPost(request("/api/mcp", { body: rpc("tools/list") }));
    expect(await disabled.text()).not.toContain(TOKEN);
  });
});
