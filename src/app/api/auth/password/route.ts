import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clearLoginFailures,
  crossOriginFailure,
  loginThrottled,
  recordLoginFailure,
  requireSessionOr401,
  sessionCookieOptions,
} from "@/lib/auth";
import { authFlowMessage, authFlowStatus, changePassword } from "@/lib/auth-flow";
import { readJson } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Immediate password change for the signed-in user. Requires the session (old secret) to prove
 * identity, then rotates hash + session secret. Other sessions are invalidated; the response sets
 * a freshly signed cookie so the current user stays signed in — no restart, no login redirect.
 */
export async function POST(request: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });

  if (loginThrottled()) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const { token } = changePassword(
      body.currentPassword,
      body.newPassword,
      body.confirm ?? body.newPasswordConfirm,
    );
    clearLoginFailures();
    const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return response;
  } catch (error) {
    const status = authFlowStatus(error);
    if (status === 400 || status === 401) recordLoginFailure();
    return NextResponse.json({ error: authFlowMessage(error) }, { status, headers: NO_STORE });
  }
}
