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
import {
  formatWeight,
  formatWeightDelta,
  toDisplayWeight,
  weightUnit,
  type Units,
} from "@/lib/units";
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
  units,
}: {
  points: Point[];
  goalKg: number | null;
  timezone: string;
  units: Units;
}) {
  const data = points.map((point) => ({
    at: point.takenAtMs,
    manual: point.source === "manual" ? toDisplayWeight(point.value, units) : null,
    apple: point.source === "apple" ? toDisplayWeight(point.value, units) : null,
  }));

  if (data.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No weight logged yet</p>;
  }

  const goal = goalKg === null ? null : toDisplayWeight(goalKg, units);
  const values = data.flatMap((point) =>
    [point.manual, point.apple].filter((value): value is number => value !== null),
  );
  if (goal !== null) values.push(goal);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max((rawMax - rawMin) * 0.08, 0.5);
  const yMin = Math.floor((rawMin - pad) * 10) / 10;
  const yMax = Math.ceil((rawMax + pad) * 10) / 10;

  const firstYear = formatLocal(data[0].at, timezone).slice(0, 4);
  const lastYear = formatLocal(data[data.length - 1].at, timezone).slice(0, 4);
  const spansYears = firstYear !== lastYear;
  const xFmt = new Intl.DateTimeFormat(
    "en-US",
    spansYears
      ? { month: "short", year: "2-digit", timeZone: timezone }
      : { month: "short", day: "numeric", timeZone: timezone },
  );
  const formatXTick = (value: number) => {
    const formatted = xFmt.format(new Date(value));
    return spansYears ? formatted.replace(" ", " '") : formatted;
  };
  const changeKg = points[points.length - 1].value - points[0].value;

  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={`Weight chart: ${points.length} entries from ${formatLocal(
          data[0].at,
          timezone,
        )} to ${formatLocal(data[data.length - 1].at, timezone)}`}
        className="h-[220px] w-full min-w-0 sm:h-[280px]"
      >
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
              tickFormatter={formatXTick}
            />
            <YAxis
              width={40}
              domain={[yMin, yMax]}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(value: number) => num(value, 0)}
            />
            <Tooltip
              {...tip}
              labelFormatter={(value) => formatLocal(Number(value), timezone)}
              formatter={(value, name) => [
                `${num(Number(value), 1)} ${weightUnit(units)}`,
                name === "manual" ? "manual" : "Apple",
              ]}
            />
            {goal !== null ? (
              <ReferenceLine
                y={goal}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 4"
                label={{
                  value: `goal ${formatWeight(goalKg, units)}`,
                  fill: "var(--muted-foreground)",
                  fontSize: 11,
                  position: "insideTopRight",
                }}
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
              isAnimationActive={false}
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
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        {points.length} entries · latest {formatWeight(points[points.length - 1].value, units)}
        {changeKg === 0 ? "" : ` · ${formatWeightDelta(changeKg, units)} since first`}
        {goalKg === null ? "" : ` · goal ${formatWeight(goalKg, units)}`}
      </p>
    </div>
  );
}
