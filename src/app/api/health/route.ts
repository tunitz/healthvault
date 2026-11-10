import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public liveness probe for Docker/reverse proxies. Deliberately carries no health data. */
export async function GET() {
  return NextResponse.json({ ok: true });
}
