import { NextResponse } from "next/server";
import { agentRequestFailure } from "@/lib/auth";
import { handleMcpRpc, mcpAccessFailure } from "@/lib/services/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Direct Streamable HTTP MCP endpoint (JSON-RPC 2.0 over POST). Stateless JSON responses; the
 * full tool list and dispatch are shared with the stdio connector via `@/lib/services/mcp`.
 * Auth uses the same session/bearer + Host/Origin gate as the agent API, plus the enable/LAN gate.
 */
export async function POST(request: Request) {
  const denial = agentRequestFailure(request);
  if (denial) return NextResponse.json({ error: denial.error }, { status: denial.status, headers: NO_STORE });

  const access = mcpAccessFailure(request);
  if (access) return NextResponse.json({ error: access.error }, { status: access.status, headers: NO_STORE });

  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "content-type must be application/json" } },
      { status: 415, headers: NO_STORE },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { headers: NO_STORE },
    );
  }

  const response = await handleMcpRpc(payload, request.signal);
  // Notifications (e.g. notifications/initialized) get no response body per JSON-RPC.
  if (response === null) return new Response(null, { status: 202, headers: NO_STORE });
  return NextResponse.json(response.body, { status: response.status, headers: NO_STORE });
}

/** Streamable HTTP clients may probe with GET; this server is POST-only and stateless. */
export async function GET() {
  return NextResponse.json(
    { error: "MCP uses JSON-RPC 2.0 POST; send initialize, tools/list or tools/call", allow: "POST" },
    { status: 405, headers: { ...NO_STORE, Allow: "POST" } },
  );
}
