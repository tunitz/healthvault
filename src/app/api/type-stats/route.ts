import { NextResponse } from "next/server";
import { recordsForType, typeStats } from "@/db/queries";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const type = new URL(req.url).searchParams.get("type");
  if (type) return NextResponse.json({ type, rows: recordsForType(type) });
  return NextResponse.json({ types: typeStats() });
}
