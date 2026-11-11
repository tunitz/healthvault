import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discovery for the plugin/agent: the same list the POST dispatcher accepts. */
export async function GET() {
  return NextResponse.json({
    tools: AGENT_TOOLS,
    transport: "POST /api/agent/<tool> with a JSON object body",
    posture: "single-user; local agent surface, no token required (trusted LAN only)",
  });
}
