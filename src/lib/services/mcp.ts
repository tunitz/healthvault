/**
 * Machine-access gating and the app's direct Streamable HTTP MCP transport.
 *
 * Two responsibilities live here:
 *  1. A single enable/LAN gate shared by the agent API, the HTTP MCP endpoint and the proxy, so
 *     toggling `mcp.enabled` really blocks machine access while the web UI keeps working.
 *  2. A stateless JSON-RPC 2.0 handler that reuses the stdio server's exact tool definitions
 *     (`plugins/healthvault/src/definitions.ts`) and dispatches through the agent API's tool map,
 *     so names, schemas and behaviour cannot drift between transports.
 *
 * No token or secret is ever read, logged or returned by this module.
 */
import { DEFAULT_MCP_SETTINGS, getSettings } from "@/lib/services/settings";
import { ValidationError } from "@/lib/validate";
import { dispatchAgentTool } from "@/app/api/agent/[tool]/route";
import { createClient } from "../../../plugins/healthvault/src/client";
import {
  createToolDefinitions,
  INSTRUCTIONS,
  SERVER_NAME,
  SERVER_VERSION,
  type ToolDefinition,
} from "../../../plugins/healthvault/src/definitions";

export interface AccessFailure {
  status: 403;
  error: string;
}

/* ---------------------------------------------------------------------------------------------
 * Request-side peer detection (local vs LAN)
 * -------------------------------------------------------------------------------------------
 * Next.js route handlers/proxy only see the Web `Request`; there is no socket remote address in
 * that API. Next sets `x-forwarded-for` from the socket remote address *only when the client did
 * not already send one* (base-server.js uses `??=`), so XFF alone is not cryptographically
 * trustworthy on a bare server — a remote client can inject a loopback value. Two real signals
 * are used instead of the client-controlled Host header:
 *
 *  - With HEALTHVAULT_TRUST_PROXY set, a trusted reverse proxy (Caddy/Tailscale) is assumed to
 *    overwrite XFF with the real client; the leftmost hop (or X-Real-IP) is the client address.
 *  - Otherwise the forwarded hops are treated as the best available server-side signal and every
 *    hop must be loopback for the request to count as local. Next always adds the socket address
 *    when the client sends no XFF, so a genuine remote request is always observed as non-loopback.
 *
 * A synthetic Request with no forwarding headers (tests, direct in-process calls) has no evidence
 * of a remote peer and is treated as local. Perfect peer authentication is not achievable with
 * the Web Request API; network-layer isolation (bind to loopback / firewall / trusted proxy) is
 * still required for a hard LAN boundary. See the report for this honest limitation.
 * ------------------------------------------------------------------------------------------- */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1", "localhost"]);

function trustProxy(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.HEALTHVAULT_TRUST_PROXY?.trim() ?? "");
}

function normalizeIp(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function forwardedHops(request: Request): string[] {
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return [];
  return xff.split(",").map((part) => normalizeIp(part)).filter(Boolean);
}

/** True when the request's best available request-side signal points at a loopback peer. */
export function isLocalPeer(request: Request): boolean {
  const hops = forwardedHops(request);
  if (trustProxy()) {
    const peer = hops[0] ?? normalizeIp(request.headers.get("x-real-ip") ?? "");
    // No forwarding header but trust-proxy mode: a direct local connection, not a proxied LAN one.
    return peer === "" || LOOPBACK.has(peer);
  }
  if (hops.length === 0) return true; // no evidence of a remote peer (see module note)
  return hops.every((hop) => LOOPBACK.has(hop));
}

/** Returns a 403 failure when machine access is disabled or a LAN peer is not permitted. */
export function mcpAccessFailure(request: Request): AccessFailure | null {
  const mcp = getSettings().value.mcp ?? DEFAULT_MCP_SETTINGS;
  if (!mcp.enabled) return { status: 403, error: "MCP is disabled" };
  if (!mcp.lanEnabled && !isLocalPeer(request)) {
    return { status: 403, error: "MCP is local-only; enable LAN access in Settings → MCP" };
  }
  return null;
}

/* ---------------------------------------------------------------------------------------------
 * Shared tool definitions, dispatched in-process through the agent tool map
 * ------------------------------------------------------------------------------------------- */

function localFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(url, "http://local").pathname;
    const tool = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
    let body: Record<string, unknown> = {};
    try {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }
    try {
      const result = await dispatchAgentTool(tool, body);
      return new Response(JSON.stringify({ ok: true, result: result ?? null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const status = error instanceof ValidationError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  }) as typeof fetch;
}

let definitionsCache: ToolDefinition[] | undefined;

/** The exact same 38 definitions the stdio server serves, backed by an in-process client. */
export function mcpToolDefinitions(): ToolDefinition[] {
  if (!definitionsCache) {
    const client = createClient({
      baseUrl: "http://localhost",
      // Local dispatch ignores auth; a non-secret placeholder keeps token resolution out of the app.
      token: "local-mcp-transport",
      fetchImpl: localFetch(),
    });
    definitionsCache = createToolDefinitions(client);
  }
  return definitionsCache;
}

/* ---------------------------------------------------------------------------------------------
 * Stateless JSON-RPC 2.0 over POST /api/mcp
 * ------------------------------------------------------------------------------------------- */

type RpcId = string | number | null;
type RpcBody = { status: number; body: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function rpcResult(id: RpcId, result: unknown): RpcBody {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function rpcError(id: RpcId, code: number, message: string, status = 200): RpcBody {
  return { status, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/**
 * Handle one JSON-RPC payload. Returns `null` for a notification (no response body, HTTP 202).
 * Supports initialize, notifications/initialized, ping, tools/list and tools/call — the standard
 * Streamable HTTP method set for a tools-only server. Responses are stateless JSON.
 */
export async function handleMcpRpc(payload: unknown, signal?: AbortSignal): Promise<RpcBody | null> {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const id: RpcId =
    typeof payload.id === "string" || typeof payload.id === "number" ? payload.id : null;
  const isNotification = payload.id === undefined;
  const params = isRecord(payload.params) ? payload.params : {};

  switch (payload.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });

    case "notifications/initialized":
      // A client notification: acknowledge with no body. A caller that supplied an id gets a
      // harmless empty result so the method still "works" if sent as a request.
      return isNotification ? null : rpcResult(id, {});

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: mcpToolDefinitions().map((definition) => ({
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: definition.annotations,
        })),
      });

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return rpcResult(id, textResult("A tool name is required.", true));
      const definition = mcpToolDefinitions().find((candidate) => candidate.name === name);
      if (!definition) {
        return rpcResult(id, textResult(`Unknown HealthVault tool "${name}".`, true));
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        const result = await definition.run(args, signal ?? new AbortController().signal);
        return rpcResult(id, textResult(JSON.stringify(result, null, 2) ?? "null"));
      } catch (error) {
        return rpcResult(id, textResult(errorText(error, `HealthVault tool ${name} failed.`), true));
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${payload.method}`);
  }
}
