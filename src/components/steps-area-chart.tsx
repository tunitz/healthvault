"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { compact, num, r2 } from "@/lib/format";

const config = {
  total: { label: "Steps", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function StepsAreaChart({ data }: { data: { day: string; total: number }[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">Steps per day</h2>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">One source per day — phone and watch are never summed together</p>
      </div>
      {data.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No data in this range</p>
      ) : (
        <ChartContainer config={config} className="h-[200px] w-full sm:h-[260px]">
          <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="fillSteps" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.35} />
                <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0} />
              </linearGradient>
            </defs>
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
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(v) => `${v}`}
                  formatter={(value) => [r2(Number(value)), "steps"]}
                />
              }
            />
            <Area
              dataKey="total"
              type="monotone"
              fill="url(#fillSteps)"
              stroke="var(--color-total)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </section>
  );
}

export function StepsSummaryLine({ avg, total }: { avg: number; total: number }) {
  return (
    <p className="text-sm text-muted-foreground">
      Average {num(avg)} steps/day · {compact(total)} total in window
    </p>
  );
}
