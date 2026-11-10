"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { compact, r2 } from "@/lib/format";

const config = {
  activeEnergy: { label: "Active energy (kcal)", color: "var(--chart-4)" },
  activeEnergyGoal: { label: "Goal (kcal)", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

export function ActivityChart({
  data,
}: {
  data: { day: string; activeEnergy: number | null; activeEnergyGoal: number | null }[];
}) {
  const latest = [...data].reverse().find((point) => point.activeEnergy !== null);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">Active energy vs goal</h2>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">Activity rings recorded by Apple Watch</p>
      </div>
      {!data.some((d) => d.activeEnergy !== null || d.activeEnergyGoal !== null) ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No data in this range</p>
      ) : (
        <ChartContainer
          config={config}
          role="img"
          aria-label={`Active energy against goal chart, ${data.length} days`}
          className="h-[200px] w-full sm:h-[260px]"
        >
          <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
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
              width={44}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(v: number) => compact(v)}
            />
            <ChartTooltip content={<ChartTooltipContent formatter={(value) => [`${r2(Number(value))} kcal`, ""]} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="activeEnergy" fill="var(--color-activeEnergy)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="activeEnergyGoal" fill="var(--color-activeEnergyGoal)" fillOpacity={0.35} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartContainer>
      )}
      {latest ? (
        <p className="text-xs text-muted-foreground">
          Latest {r2(latest.activeEnergy ?? 0, 0)} kcal
          {latest.activeEnergyGoal === null ? "" : ` of ${r2(latest.activeEnergyGoal, 0)} kcal`} on {latest.day}.
        </p>
      ) : null}
    </section>
  );
}
