/**
 * Machine-access gating and the app's direct Streamable HTTP MCP transport.
 *
 * Two responsibilities live here:
 *  1. A single enable/LAN gate shared by the agent API, the HTTP MCP endpoint and the proxy, so
 *     toggling `mcp.enabled` really blocks machine access while the web UI keeps working.
 *  2. A stateless JSON-RPC 2.0 handler that reuses the stdio server's exact tool, resource and
 *     prompt definitions (`plugins/healthvault/src/definitions.ts`) and dispatches directly to
 *     `dispatchAgentTool()` in-process with zero synthetic fetch/JSON round-trips.
 *
 * No token or secret is ever read, logged or returned by this module.
 */
import { DEFAULT_MCP_SETTINGS, getSettings } from "@/lib/services/settings";
import { dispatchAgentTool } from "@/app/api/agent/[tool]/route";
import { createClient } from "../../../plugins/healthvault/src/client";
import {
  buildPromptMessages,
  createToolDefinitions,
  INSTRUCTIONS,
  MCP_PROMPTS,
  MCP_RESOURCES,
  SERVER_NAME,
  SERVER_VERSION,
  type ToolDefinition,
} from "../../../plugins/healthvault/src/definitions";

export interface AccessFailure {
  status: 403;
  error: string;
}

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
    return peer === "" || LOOPBACK.has(peer);
  }
  if (hops.length === 0) return true;
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
 * Shared tool definitions, dispatched directly in-process (no synthetic fetch / JSON round-trip)
 * ------------------------------------------------------------------------------------------- */

function agentToolNameFor(mcpName: string): string {
  return mcpName === "healthvault_context" ? "healthvault_context" : mcpName.replace(/^healthvault_/, "");
}

let definitionsCache: ToolDefinition[] | undefined;
let definitionsByNameCache: Map<string, ToolDefinition> | undefined;

/** The exact same definitions the stdio server serves, backed by direct in-process dispatch. */
export function mcpToolDefinitions(): ToolDefinition[] {
  if (!definitionsCache) {
    // Only used to extract schema/description/annotation metadata; `run` is wired directly in-process.
    const unusedClient = createClient({
      baseUrl: "http://localhost",
      token: "local-mcp-metadata-only",
      fetchImpl: (() => {
        throw new Error("In-process MCP transport must dispatch directly without fetch");
      }) as unknown as typeof fetch,
    });
    definitionsCache = createToolDefinitions(unusedClient).map((definition) => {
      const agentTool = agentToolNameFor(definition.name);
      return {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
        run: (input) =>
          dispatchAgentTool(
            agentTool,
            isRecord(input) ? input : {},
          ),
      };
    });
    definitionsByNameCache = new Map(definitionsCache.map((d) => [d.name, d]));
  }
  return definitionsCache;
}

function mcpToolByName(name: string): ToolDefinition | undefined {
  mcpToolDefinitions();
  return definitionsByNameCache?.get(name);
}

/* ---------------------------------------------------------------------------------------------
 * Stateless JSON-RPC 2.0 over POST /api/mcp (single and batch requests)
 * ------------------------------------------------------------------------------------------- */

type RpcId = string | number | null;
type RpcSingleBody = Record<string, unknown>;
type RpcBody = { status: number; body: RpcSingleBody | RpcSingleBody[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function rpcResult(id: RpcId, result: unknown): { status: number; body: RpcSingleBody } {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function rpcError(id: RpcId, code: number, message: string, status = 200): { status: number; body: RpcSingleBody } {
  return { status, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function textResult(text: string, isError = false, structuredContent?: Record<string, unknown>): Record<string, unknown> {
  if (isError) return { content: [{ type: "text", text }], isError: true };
  return structuredContent
    ? { content: [{ type: "text", text }], structuredContent }
    : { content: [{ type: "text", text }] };
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

async function handleSingleRpc(
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; body: RpcSingleBody } | null> {
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
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });

    case "notifications/initialized":
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
      const definition = mcpToolByName(name);
      if (!definition) {
        return rpcResult(id, textResult(`Unknown HealthVault tool "${name}".`, true));
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        const result = await definition.run(args, signal ?? new AbortController().signal);
        const text = JSON.stringify(result) ?? "null";
        return rpcResult(id, textResult(text, false, isRecord(result) ? result : undefined));
      } catch (error) {
        return rpcResult(id, textResult(errorText(error, `HealthVault tool ${name} failed.`), true));
      }
    }

    case "resources/list":
      return rpcResult(id, {
        resources: MCP_RESOURCES.map(({ uri, name, description, mimeType }) => ({
          uri,
          name,
          description,
          mimeType,
        })),
      });

    case "resources/read": {
      const uri = params.uri;
      if (typeof uri !== "string") return rpcError(id, -32602, "Resource uri is required");
      const resource = MCP_RESOURCES.find((r) => r.uri === uri);
      if (!resource) return rpcError(id, -32002, `Resource not found: ${uri}`);
      try {
        const result = await dispatchAgentTool(resource.tool, resource.args);
        return rpcResult(id, {
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: JSON.stringify(result) ?? "null",
            },
          ],
        });
      } catch (error) {
        return rpcError(id, -32603, errorText(error, `Failed to read resource ${uri}`));
      }
    }

    case "prompts/list":
      return rpcResult(id, {
        prompts: MCP_PROMPTS.map(({ name, description, arguments: promptArgs }) => ({
          name,
          description,
          ...(promptArgs ? { arguments: promptArgs } : {}),
        })),
      });

    case "prompts/get": {
      const name = params.name;
      if (typeof name !== "string") return rpcError(id, -32602, "Prompt name is required");
      const rawArgs = isRecord(params.arguments) ? params.arguments : {};
      const stringArgs: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(rawArgs)) {
        if (typeof v === "string") stringArgs[k] = v;
        else if (typeof v === "number") stringArgs[k] = String(v);
      }
      const prompt = buildPromptMessages(name, stringArgs);
      if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${name}`);
      return rpcResult(id, prompt);
    }

    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${payload.method}`);
  }
}

/**
 * Handle one JSON-RPC 2.0 payload or a batch array of payloads.
 * Returns `null` when every item is a notification (no response body, HTTP 202).
 */
export async function handleMcpRpc(payload: unknown, signal?: AbortSignal): Promise<RpcBody | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return rpcError(null, -32600, "Invalid Request");
    const responses: RpcSingleBody[] = [];
    for (const item of payload) {
      const res = await handleSingleRpc(item, signal);
      if (res !== null) responses.push(res.body);
    }
    if (responses.length === 0) return null;
    return { status: 200, body: responses };
  }
  return handleSingleRpc(payload, signal);
}
