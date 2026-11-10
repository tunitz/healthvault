import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { requireToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discovery for the plugin/agent: the same list the POST dispatcher accepts. */
export async function GET(request: Request) {
  const denied = requireToken(request);
  if (denied) return denied;

  return NextResponse.json({
    tools: AGENT_TOOLS,
    transport: "POST /api/agent/<tool> with a JSON object body",
    posture: "single-user; Authorization: Bearer token required on every request",
  });
}
