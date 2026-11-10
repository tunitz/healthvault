"use client";

import {
  Area, AreaChart, Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { compact, num, r2 } from "@/lib/format";

/**
 * Training visuals. Colours come from the theme chart tokens (--chart-1..5) and the neutral
 * chrome tokens (--border, --muted-foreground, --card), so they follow light and dark mode.
 */
const C = {
  steps: "var(--chart-1)",
  hr: "var(--chart-5)",
  distance: "var(--chart-2)",
  pace: "var(--chart-4)",
  resting: "var(--chart-2)",
  vo2: "var(--chart-1)",
  minutes: "var(--chart-3)",
  grid: "var(--border)",
  ref: "var(--muted-foreground)",
};

const axis = {
  stroke: "var(--muted-foreground)",
  tick: { fill: "var(--muted-foreground)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

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

const xTicks = { tickMargin: 8, minTickGap: 40, interval: "preserveStartEnd" as const };

function Section({ title, description, children }: {
  title: string; description: string; children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="py-12 text-center text-sm text-muted-foreground">{children}</p>;
}

const NO_RANGE = "No data in this range";

function Chart({ children }: { children: React.ReactElement }) {
  return (
    <div className="h-[200px] w-full sm:h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

export function StepsChart({ data }: { data: { day: string; value: number; source: string }[] }) {
  const avg = data.length ? data.reduce((a, d) => a + d.value, 0) / data.length : 0;
  const source = data[0]?.source ?? "";
  return (
    <Section
      title="Steps per day"
      description={source ? `From ${source} — one device per day, sources are never summed together` : "No step records yet"}
    >
      {data.length === 0 ? <Empty>{NO_RANGE}</Empty> : (
        <Chart>
          <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="gSteps" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.steps} stopOpacity={0.35} />
                <stop offset="100%" stopColor={C.steps} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="day" {...axis} {...xTicks} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis width={44} {...axis} tickFormatter={(v: number) => compact(v)} />
            <Tooltip {...tip} formatter={(v, name) => [`${r2(Number(v))} steps`, name]} />
            <ReferenceLine
              y={avg}
              stroke={C.ref}
              strokeDasharray="4 4"
              label={{ value: `avg ${compact(avg)}`, fill: C.ref, fontSize: 11, position: "insideTopRight" }}
            />
            <Area dataKey="value" name="steps" type="monotone" stroke={C.steps} strokeWidth={2} fill="url(#gSteps)" />
          </AreaChart>
        </Chart>
      )}
    </Section>
  );
}

export function WeeklyVolumeChart({ data }: { data: { weekStart: string; weekEnd: string; sessions: number; minutes: number | null; km: number | null; avgHr: number | null }[] }) {
  // hover shows the actual Sunday–Saturday span, not just the first day of the week
  const range = new Map(data.map((d) => [d.weekStart, `${d.weekStart} → ${d.weekEnd}`]));
  return (
    <Section title="Weekly training volume" description="Minutes trained per week, with distance on the right axis">
      {data.length === 0 || data.every((d) => d.minutes === null && d.km === null) ? <Empty>{NO_RANGE}</Empty> : (
        <Chart>
          <ComposedChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="weekStart" {...axis} {...xTicks} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis width={44} {...axis} domain={[0, "auto"]} tickFormatter={(v: number) => compact(v)} />
            <YAxis yAxisId="km" orientation="right" width={36} {...axis} tickFormatter={(v: number) => num(v, 0)} />
            <Tooltip
              {...tip}
              labelFormatter={(label) => range.get(String(label)) ?? String(label)}
              formatter={(v, name) => [name === "km" ? `${r2(Number(v))} km` : `${r2(Number(v))} min`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="minutes"
              name="minutes"
              fill={C.minutes}
              radius={[3, 3, 0, 0]}
              barSize={data.length === 1 ? 28 : undefined}
              maxBarSize={28}
              minPointSize={3}
              fillOpacity={0.85}
            />
            <Line yAxisId="km" dataKey="km" name="km" type="monotone" stroke={C.distance} strokeWidth={2} dot={{ r: 2.5 }} />
          </ComposedChart>
        </Chart>
      )}
    </Section>
  );
}

export function PaceTrendChart({ data }: { data: { day: string; paceMinPerKm: number | null; km: number | null; avgHr: number | null }[] }) {
  const points = data.filter((d) => d.paceMinPerKm !== null);
  return (
    <Section title="Run pace" description="Minutes per km — lower is faster, so the line going down is progress">
      {points.length === 0 ? <Empty>{NO_RANGE}</Empty> : (
        <Chart>
          <LineChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="day" {...axis} {...xTicks} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis width={44} {...axis} domain={["auto", "auto"]} tickFormatter={(v: number) => r2(v)} />
            <Tooltip {...tip} formatter={(v) => [`${Number(v).toFixed(2)} min/km`, "pace"]} />
            <Line dataKey="paceMinPerKm" name="min/km" type="monotone" stroke={C.pace} strokeWidth={2} dot={{ r: 2.5, fill: C.pace }} activeDot={{ r: 4 }} />
          </LineChart>
        </Chart>
      )}
    </Section>
  );
}

export function WorkoutHrChart({ data }: { data: { day: string; avgHr: number | null; maxHr: number | null }[] }) {
  const points = data.filter((d) => d.avgHr !== null);
  const avg = points.length ? points.reduce((a, d) => a + (d.avgHr ?? 0), 0) / points.length : 0;
  return (
    <Section
      title="Heart rate per workout"
      description="Average and peak from the workout itself. At the same pace, a falling average means you are getting fitter."
    >
      {points.length === 0 ? <Empty>{NO_RANGE}</Empty> : (
        <Chart>
          <ComposedChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="gMaxHr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.hr} stopOpacity={0.25} />
                <stop offset="100%" stopColor={C.hr} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="day" {...axis} {...xTicks} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis width={40} {...axis} domain={["auto", "auto"]} />
            <Tooltip {...tip} formatter={(v, name) => [`${r2(Number(v))} bpm ${name === "max" ? "(peak)" : "(avg)"}`, name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={avg} stroke={C.ref} strokeDasharray="4 4" />
            <Area dataKey="maxHr" name="max" type="monotone" stroke={C.hr} strokeWidth={1.5} fill="url(#gMaxHr)" />
            <Line dataKey="avgHr" name="avg" type="monotone" stroke={C.hr} strokeWidth={2} dot={{ r: 2.5 }} />
          </ComposedChart>
        </Chart>
      )}
    </Section>
  );
}

export function FitnessTrendChart({ resting, vo2 }: {
  resting: { day: string; value: number }[];
  vo2: { day: string; value: number }[];
}) {
  // two series on different scales: resting HR (bpm) and VO2max (ml/kg/min)
  const byDay = new Map<string, { day: string; resting?: number; vo2?: number }>();
  for (const r of resting) (byDay.get(r.day) ?? byDay.set(r.day, { day: r.day }).get(r.day)!).resting = r.value;
  for (const v of vo2) (byDay.get(v.day) ?? byDay.set(v.day, { day: v.day }).get(v.day)!).vo2 = v.value;
  const data = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  return (
    <Section
      title="Fitness trend"
      description="Resting heart rate (bpm) and VO2max (ml/kg/min) — resting HR down and VO2max up both mean progress"
    >
      {data.length === 0 ? <Empty>{NO_RANGE}</Empty> : (
        <Chart>
          <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="day" {...axis} {...xTicks} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis yAxisId="hr" width={40} {...axis} domain={["auto", "auto"]} />
            <YAxis yAxisId="vo2" orientation="right" width={36} {...axis} domain={["auto", "auto"]} tickFormatter={(v: number) => v.toFixed(0)} />
            <Tooltip {...tip} formatter={(v, name) => [`${r2(Number(v))} ${name === "VO2max" ? "ml/kg/min" : "bpm"}`, name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line yAxisId="hr" dataKey="resting" name="resting HR" type="monotone" stroke={C.resting} strokeWidth={2} dot={false} connectNulls />
            <Line yAxisId="vo2" dataKey="vo2" name="VO2max" type="monotone" stroke={C.vo2} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </Chart>
      )}
    </Section>
  );
}

export function HeartRateDailyChart({ data }: { data: { day: string; value: number; source: string }[] }) {
  return (
    <Section title="Daily heart rate" description="Average of each day's samples from a single source">
      {data.length === 0 ? <Empty>{NO_RANGE}</Empty> : (
        <Chart>
          <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="gHr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.hr} stopOpacity={0.3} />
                <stop offset="100%" stopColor={C.hr} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="day" {...axis} {...xTicks} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis width={40} {...axis} domain={["auto", "auto"]} />
            <Tooltip {...tip} formatter={(v, name) => [`${r2(Number(v))} bpm`, name]} />
            <Area dataKey="value" name="bpm" type="monotone" stroke={C.hr} strokeWidth={2} fill="url(#gHr)" />
          </AreaChart>
        </Chart>
      )}
    </Section>
  );
}
