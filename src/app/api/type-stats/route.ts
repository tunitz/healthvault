import { NextResponse } from "next/server";
import { requireSessionOr401 } from "@/lib/auth";
import { recordsForType, typeStats } from "@/db/queries";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;

  const type = new URL(req.url).searchParams.get("type");
  if (type) return NextResponse.json({ type, rows: recordsForType(type) });
  return NextResponse.json({ types: typeStats() });
}
