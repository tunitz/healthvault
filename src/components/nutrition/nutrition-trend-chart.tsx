"use client";

import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { num } from "@/lib/format";

const config = {
  kcal: { label: "Eaten (kcal)", color: "var(--chart-1)" },
  targetKcal: { label: "Target (kcal)", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function NutritionTrendChart({
  data,
}: {
  data: { day: string; kcal: number; targetKcal: number }[];
}) {
  const avgEaten = data.length ? data.reduce((sum, point) => sum + point.kcal, 0) / data.length : 0;
  const avgTarget = data.length ? data.reduce((sum, point) => sum + point.targetKcal, 0) / data.length : 0;
  return (
    <div className="flex flex-col gap-3">
      <ChartContainer
        config={config}
        role="img"
        aria-label={`Eaten calories against target, ${data.length} days`}
        className="h-[200px] w-full sm:h-[240px]"
      >
        <ComposedChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={40}
            interval="preserveStartEnd"
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickFormatter={(value: string) => value.slice(5)}
          />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickFormatter={(value: number) => num(value, 0)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => `${value}`}
                formatter={(value, name) => [`${num(Number(value), 0)} kcal`, name]}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="kcal" fill="var(--color-kcal)" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          <Line
            dataKey="targetKcal"
            type="monotone"
            stroke="var(--color-targetKcal)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>
      {data.length ? (
        <p className="text-xs text-muted-foreground">
          Average {num(avgEaten, 0)} kcal/day against {num(avgTarget, 0)} kcal target.
        </p>
      ) : null}
    </div>
  );
}
