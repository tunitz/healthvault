import { NextResponse } from "next/server";
import { requireSessionOr401 } from "@/lib/auth";
import { localDay } from "@/lib/day";
import { getTimezone } from "@/lib/services/profile";
import { dueSupplements } from "@/lib/services/supplements";

export const runtime = "nodejs";

/**
 * Scheduled supplements already due today, for the optional open-tab reminder. `item` remains
 * the earliest due item for compatibility with existing clients. Session-guarded here as well
 * as by the proxy.
 */
export async function GET() {
  const denied = await requireSessionOr401();
  if (denied) return denied;

  const day = localDay(Date.now(), getTimezone());
  const items = dueSupplements(day);
  return NextResponse.json({ day, items, item: items[0] ?? null });
}
