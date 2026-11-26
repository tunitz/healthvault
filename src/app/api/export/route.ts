import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  foodLog,
  foodLogIngredients,
  foods,
  measurements,
  nutritionTargets,
  plannedSessions,
  profile,
  recipeIngredients,
  recipes,
  strengthSets,
  supplementLogs,
  supplements,
} from "@/db/schema";
import { requireSessionOr401 } from "@/lib/auth";
import { currentDay } from "@/lib/services/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(",")];
  for (const row of rows) {
    lines.push(keys.map((k) => csvCell(row[k])).join(","));
  }
  return lines.join("\n");
}

/**
 * Authenticated export of all manual HealthVault data (JSON bundle or per-table CSV).
 * Never includes credentials, session secrets, or bearer tokens.
 */
export async function GET(req: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;

  const sp = new URL(req.url).searchParams;
  const format = (sp.get("format") ?? "json").toLowerCase();
  const table = (sp.get("table") ?? "food_log").toLowerCase();
  const stamp = currentDay();

  if (format === "csv") {
    let rows: Record<string, unknown>[] = [];
    if (table === "measurements") {
      rows = db.select().from(measurements).all();
    } else if (table === "foods") {
      rows = db.select().from(foods).all();
    } else if (table === "supplements") {
      rows = db.select().from(supplementLogs).all().map((r) => {
        const { wheyActionId: _w, ...rest } = r;
        void _w;
        return rest;
      });
    } else if (table === "strength") {
      rows = db.select().from(strengthSets).all();
    } else {
      rows = db.select().from(foodLog).all().map((r) => {
        const { wheyActionJson: _wj, wheyActionDay: _wd, ...rest } = r;
        void _wj;
        void _wd;
        return rest;
      });
    }
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="healthvault-${table}-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    profile: db.select().from(profile).all(),
    measurements: db.select().from(measurements).all(),
    nutritionTargets: db.select().from(nutritionTargets).all(),
    foods: db.select().from(foods).all(),
    recipes: db.select().from(recipes).all(),
    recipeIngredients: db.select().from(recipeIngredients).all(),
    foodLog: db.select().from(foodLog).all().map((r) => {
      const { wheyActionJson: _wj, wheyActionDay: _wd, ...rest } = r;
      void _wj;
      void _wd;
      return rest;
    }),
    foodLogIngredients: db.select().from(foodLogIngredients).all(),
    supplements: db.select().from(supplements).all(),
    supplementLogs: db.select().from(supplementLogs).all().map((r) => {
      const { wheyActionId: _w, ...rest } = r;
      void _w;
      return rest;
    }),
    plannedSessions: db.select().from(plannedSessions).all(),
    strengthSets: db.select().from(strengthSets).all(),
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="healthvault-export-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
