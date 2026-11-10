import { NextResponse } from "next/server";
import { SESSION_COOKIE, expiredSessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", expiredSessionCookieOptions());
  response.headers.set("Clear-Site-Data", '"cache", "cookies", "storage"');
  response.headers.set("Cache-Control", "no-store");
  return response;
}
