"use client";

import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { compact, num } from "@/lib/format";

export type SeriesPoint = { day: string; value: number };

/** One chart component for the meaningful line / area / bar views. Values come straight from the
 *  shared data loader; switching `kind` never recomputes or reformats the underlying numbers. */
export function SeriesChart({
  data,
  kind,
  label,
  unit = "",
  colorVar = "var(--chart-1)",
  ariaLabel,
  xTickFormatter,
}: {
  data: SeriesPoint[];
  kind: "line" | "area" | "bars";
  label: string;
  unit?: string;
  colorVar?: string;
  ariaLabel: string;
  xTickFormatter?: (value: string) => string;
}) {
  const gradientId = `series-fill-${useId().replace(/:/g, "")}`;
  const config = { value: { label, color: colorVar } } satisfies ChartConfig;
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No data in this range</p>;
  }
  const formatX = xTickFormatter ?? ((value: string) => String(value).slice(5));
  const axis = (
    <>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis
        dataKey="day"
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={40}
        interval="preserveStartEnd"
        tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
        tickFormatter={(value: string) => formatX(String(value))}
      />
      <YAxis
        width={44}
        tickLine={false}
        axisLine={false}
        tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
        tickFormatter={(value: number) => compact(value)}
      />
      <ChartTooltip
        content={<ChartTooltipContent formatter={(value) => [`${num(Number(value))}${unit ? ` ${unit}` : ""}`, label]} />}
      />
    </>
  );
  const common = { data, margin: { left: 0, right: 8, top: 8 } };

  return (
    <ChartContainer config={config} role="img" aria-label={ariaLabel} className="h-[180px] w-full sm:h-[220px]">
      {kind === "bars" ? (
        <BarChart {...common}>
          {axis}
          <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      ) : kind === "line" ? (
        <LineChart {...common}>
          {axis}
          <Line type="monotone" dataKey="value" stroke="var(--color-value)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      ) : (
        <AreaChart {...common}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {axis}
          <Area type="monotone" dataKey="value" stroke="var(--color-value)" fill={`url(#${gradientId})`} strokeWidth={2} isAnimationActive={false} />
        </AreaChart>
      )}
    </ChartContainer>
  );
}
