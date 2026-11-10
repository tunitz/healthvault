"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatLocal } from "@/lib/day";
import { num } from "@/lib/format";
import type { Point } from "@/lib/services/measurements";

const tip = {
  contentStyle: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 12,
    color: "var(--card-foreground)",
    boxShadow: "none",
  },
  labelStyle: { color: "var(--muted-foreground)", marginBottom: 2 },
  itemStyle: { color: "var(--card-foreground)" },
} as const;

export function WeightChart({
  points,
  goalKg,
  timezone,
}: {
  points: Point[];
  goalKg: number | null;
  timezone: string;
}) {
  const data = points.map((point) => ({
    at: point.takenAtMs,
    manual: point.source === "manual" ? point.value : null,
    apple: point.source === "apple" ? point.value : null,
  }));

  if (data.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No weight logged yet</p>;
  }

  return (
    <div className="h-[220px] w-full sm:h-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="at"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={48}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickFormatter={(value: number) => formatLocal(value, timezone).slice(5, 10)}
          />
          <YAxis
            width={40}
            domain={["auto", "auto"]}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickFormatter={(value: number) => num(value, 0)}
          />
          <Tooltip
            {...tip}
            labelFormatter={(value) => formatLocal(Number(value), timezone)}
            formatter={(value, name) => [`${num(Number(value))} kg`, name === "manual" ? "manual" : "Apple"]}
          />
          {goalKg !== null ? (
            <ReferenceLine
              y={goalKg}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              label={{ value: `goal ${num(goalKg)}`, fill: "var(--muted-foreground)", fontSize: 11, position: "insideTopRight" }}
            />
          ) : null}
          <Line
            dataKey="manual"
            name="manual"
            type="monotone"
            connectNulls={false}
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--chart-1)" }}
            activeDot={{ r: 4 }}
          />
          <Line
            dataKey="apple"
            name="apple"
            type="monotone"
            connectNulls={false}
            stroke="var(--chart-2)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--chart-2)" }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
