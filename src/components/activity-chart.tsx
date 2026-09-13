"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  activeEnergy: { label: "Active energy (kcal)", color: "#f59e0b" },
  activeEnergyGoal: { label: "Goal (kcal)", color: "#64748b" },
} satisfies ChartConfig;

export function ActivityChart({
  data,
}: {
  data: { day: string; activeEnergy: number | null; activeEnergyGoal: number | null }[];
}) {
  return (
    <Card className="overflow-hidden border-amber-500/20 bg-gradient-to-b from-amber-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-amber-400">Active energy vs goal</CardTitle>
        <CardDescription>From ActivitySummary rings recorded by Apple Watch</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No activity summaries yet.</p>
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis width={48} tickLine={false} axisLine={false} tickFormatter={(v: number) => compact(v)} />
              <ChartTooltip content={<ChartTooltipContent formatter={(value) => [`${r2(Number(value))} kcal`, ""]} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="activeEnergy" fill="var(--color-activeEnergy)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="activeEnergyGoal" fill="var(--color-activeEnergyGoal)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
