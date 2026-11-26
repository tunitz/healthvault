import { NextResponse } from "next/server";
import { crossOriginFailure, requireSessionOr401 } from "@/lib/auth";
import { CredentialConflictError } from "@/lib/auth-config";
import { getAgentTokenState, rotateAgentToken } from "@/lib/services/agent-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET the effective harness token and its source. Session + Origin protected, never cached. */
export async function GET(request: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });
  return NextResponse.json(getAgentTokenState(), { headers: NO_STORE });
}

/** POST rotates the token, invalidating the previous value immediately. */
export async function POST(request: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });
  try {
    return NextResponse.json(rotateAgentToken(), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CredentialConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: NO_STORE });
    }
    // Generic message: never put the token, a stack, or a DB error in the response or logs.
    return NextResponse.json(
      { error: "Could not rotate the harness token" },
      { status: 500, headers: NO_STORE },
    );
  }
}
