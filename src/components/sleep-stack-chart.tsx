"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { r2 } from "@/lib/format";

const config = {
  inBed: { label: "In bed", color: "var(--muted-foreground)" }, // kept for exports that only have InBed rows
  asleep: { label: "Asleep", color: "var(--chart-2)" },
  awake: { label: "Awake", color: "var(--chart-4)" },
  core: { label: "Core", color: "var(--chart-3)" },
  deep: { label: "Deep", color: "var(--chart-1)" },
  rem: { label: "REM", color: "var(--chart-5)" },
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
  const nightTotals = rows.map((row) =>
    KEYS.filter((key) => key !== "inBed").reduce((sum, key) => sum + Number(row[key]), 0),
  );
  const avgHours = nightTotals.length
    ? nightTotals.reduce((sum, hours) => sum + hours, 0) / nightTotals.length
    : 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">Sleep by stage</h2>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
          Hours asleep per night; InBed rows are excluded
        </p>
      </div>
      {present.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No data in this range</p>
      ) : (
        <ChartContainer
          config={config}
          role="img"
          aria-label={`Sleep by stage chart, ${rows.length} nights`}
          className="h-[200px] w-full sm:h-[260px]"
        >
          <BarChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={40}
              interval="preserveStartEnd"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              width={36}
              tickLine={false}
              axisLine={false}
              unit="h"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
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
                radius={i === present.length - 1 ? [3, 3, 0, 0] : 0}
              />
            ))}
          </BarChart>
        </ChartContainer>
      )}
      {present.length ? (
        <p className="text-xs text-muted-foreground">
          Average {r2(avgHours, 1)} h over {rows.length} nights.
        </p>
      ) : null}
    </section>
  );
}
