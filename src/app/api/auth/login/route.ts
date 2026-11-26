import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clearLoginFailures,
  loginThrottled,
  recordLoginFailure,
  sessionCookieOptions,
  signSession,
  verifyPassword,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Throttle before doing any password work, so failures stay cheap.
  if (loginThrottled()) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429 });
  }

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  if (!password || !verifyPassword(password)) {
    recordLoginFailure();
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  clearLoginFailures();
  const response = NextResponse.json({ ok: true });
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(SESSION_COOKIE, signSession(), sessionCookieOptions());
  return response;
}
