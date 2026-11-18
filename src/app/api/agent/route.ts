import { NextResponse } from "next/server";
import { agentRequestFailure } from "@/lib/auth";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { mcpAccessFailure } from "@/lib/services/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discovery for the plugin/agent: the same list the POST dispatcher accepts. */
export async function GET(request: Request) {
  const failure = agentRequestFailure(request);
  if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
  const access = mcpAccessFailure(request);
  if (access) return NextResponse.json({ error: access.error }, { status: access.status });
  return NextResponse.json({
    tools: AGENT_TOOLS,
    transport: "POST /api/agent/<tool> with a JSON object body",
    posture: "single-user; bearer token or session required; Host/Origin checked",
  });
}
