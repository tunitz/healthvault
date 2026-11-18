import { NextResponse } from "next/server";
import { crossOriginFailure, requireSessionOr401 } from "@/lib/auth";
import { DEFAULT_MCP_SETTINGS, getSettings } from "@/lib/services/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * UI-only status for Settings → MCP. Session + Origin checked (not a machine endpoint), and it
 * deliberately carries no credential, token or secret — only the current enablement flags and
 * connection metadata the page renders.
 */
export async function GET(request: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });

  const snapshot = getSettings();
  const mcp = snapshot.value.mcp ?? DEFAULT_MCP_SETTINGS;
  return NextResponse.json(
    {
      enabled: mcp.enabled,
      lanEnabled: mcp.lanEnabled,
      revision: snapshot.revision,
      endpoint: "/api/mcp",
      transports: ["stdio", "streamable-http"],
    },
    { headers: NO_STORE },
  );
}
