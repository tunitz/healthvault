"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { compact, num } from "@/lib/format";

const config = {
  total: { label: "Steps", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function StepsAreaChart({ data }: { data: { day: string; total: number }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Steps per day</CardTitle>
        <CardDescription>Sum of every step-count record, grouped by export-local day</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No step records yet.</p>
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="fillSteps" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.7} />
                  <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                width={48}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => compact(v)}
              />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(v) => `${v}`} />}
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
      </CardContent>
    </Card>
  );
}

export function StepsSummaryLine({ avg, total }: { avg: number; total: number }) {
  return (
    <p className="text-sm text-muted-foreground">
      Average {num(avg)} steps/day · {compact(total)} total in window
    </p>
  );
}
