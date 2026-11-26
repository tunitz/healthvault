import { NextResponse } from "next/server";
import { requireSessionOr401 } from "@/lib/auth";
import {
  explorerDailyTrend,
  explorerSources,
  recordsForType,
  typeStats,
} from "@/db/queries";
import { isDay } from "@/lib/day";

export const runtime = "nodejs";

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;

  const sp = new URL(req.url).searchParams;
  const type = sp.get("type");
  if (!type) return NextResponse.json({ types: typeStats() });

  const rawFrom = sp.get("from")?.trim() || undefined;
  const rawTo = sp.get("to")?.trim() || undefined;
  const source = sp.get("source")?.trim() || undefined;
  const filters = {
    fromDay: rawFrom && isDay(rawFrom) ? rawFrom : undefined,
    toDay: rawTo && isDay(rawTo) ? rawTo : undefined,
    source,
  };
  const format = sp.get("format")?.trim().toLowerCase();

  if (format === "csv" || format === "json") {
    const rows = recordsForType(type, 2000, filters);
    const safeName = type.replace(/[^a-zA-Z0-9_-]+/g, "_");
    if (format === "json") {
      return new Response(JSON.stringify({ type, filters, rows }, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeName}.json"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const header = "day,startDate,endDate,value,unit,sourceName";
    const lines = rows.map((r) =>
      [r.day, r.startDate, r.endDate, r.value, r.unit, r.sourceName].map(csvCell).join(","),
    );
    return new Response([header, ...lines].join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json({
    type,
    rows: recordsForType(type, 200, filters),
    trend: explorerDailyTrend(type, filters),
    sources: explorerSources(type),
  });
}
