import { NextResponse } from "next/server";
import { SESSION_COOKIE, clearLoginFailures, crossOriginFailure, loginThrottled, recordLoginFailure, sessionCookieOptions } from "@/lib/auth";
import { authFlowMessage, authFlowStatus, setupPassword } from "@/lib/auth-flow";
import { getAuthState } from "@/lib/auth-config";
import { readJson } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * First-run setup, allowed exactly once. UNCONFIGURED only (no env credentials and no stored
 * credentials). The database CAS rejects concurrent/second attempts even if two requests pass the
 * pre-check. Throttled like login; a successful setup sets the session cookie and closes setup.
 */
export async function POST(request: Request) {
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });

  if (loginThrottled()) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429, headers: NO_STORE });
  }
  if (getAuthState() !== "unconfigured") {
    return NextResponse.json({ error: "HealthVault is already set up" }, { status: 409, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const { token } = setupPassword(body.password, body.confirm ?? body.confirmPassword);
    clearLoginFailures();
    const response = NextResponse.json({ ok: true }, { status: 201, headers: NO_STORE });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return response;
  } catch (error) {
    const status = authFlowStatus(error);
    if (status === 400 || status === 401) recordLoginFailure();
    return NextResponse.json({ error: authFlowMessage(error) }, { status, headers: NO_STORE });
  }
}
