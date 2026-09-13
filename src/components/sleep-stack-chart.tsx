"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { r2 } from "@/lib/format";

const config = {
  inBed: { label: "In bed", color: "#64748b" }, // kept for exports that only have InBed rows
  asleep: { label: "Asleep", color: "#6366f1" },
  awake: { label: "Awake", color: "#f59e0b" },
  core: { label: "Core", color: "#a78bfa" },
  deep: { label: "Deep", color: "#06b6d4" },
  rem: { label: "REM", color: "#ec4899" },
} satisfies ChartConfig;

const KEYS = ["inBed", "asleep", "awake", "core", "deep", "rem"] as const;
const STAGE_KEY: Record<number, (typeof KEYS)[number]> = {
  1: "inBed", 2: "asleep", 3: "awake", 4: "core", 5: "deep", 6: "rem",
};

export function SleepStackChart({ data }: { data: { day: string; stage: number; hours: number }[] }) {
  const byDay = new Map<string, Record<string, number | string>>();
  for (const r of data) {
    const key = STAGE_KEY[r.stage];
    if (!key) continue;
    const row = byDay.get(r.day) ?? { day: r.day };
    row[key] = (Number(row[key] ?? 0) + r.hours);
    byDay.set(r.day, row);
  }
  const rows = [...byDay.values()].map((row) => {
    const out: Record<string, number | string> = { day: row.day as string };
    for (const k of KEYS) out[k] = Number(Number(row[k] ?? 0).toFixed(2));
    return out;
  });

  const present = KEYS.filter((k) => rows.some((r) => Number(r[k]) > 0));

  return (
    <Card className="overflow-hidden border-violet-500/20 bg-gradient-to-b from-violet-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-violet-400">Sleep by stage</CardTitle>
        <CardDescription>
          Hours asleep per night (InBed rows excluded: they cover the whole night and would double count)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No sleep records yet.</p>
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis width={40} tickLine={false} axisLine={false} unit="h" />
              <ChartTooltip
                content={<ChartTooltipContent formatter={(value) => [`${r2(Number(value))} h`, ""]} />}
              />
              <ChartLegend content={<ChartLegendContent />} />
              {present.map((key, i) => (
                <Bar
                  key={key}
                  dataKey={key}
                  stackId="sleep"
                  fill={`var(--color-${key})`}
                  radius={i === present.length - 1 ? [4, 4, 0, 0] : 0}
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
