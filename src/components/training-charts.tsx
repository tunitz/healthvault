"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { compact, num } from "@/lib/format";

/**
 * Training visuals. Colours are literal hex rather than theme tokens: these are the screens the
 * user reads every day and they need to be legible and distinct at a glance, not to follow the
 * neutral chrome palette.
 */
const C = {
  steps: "#10b981",
  stepsSoft: "#34d399",
  hr: "#f43f5e",
  hrSoft: "#fb7185",
  distance: "#8b5cf6",
  pace: "#f59e0b",
  resting: "#06b6d4",
  vo2: "#84cc16",
  minutes: "#6366f1",
  grid: "rgba(148,163,184,0.18)",
};

const axis = { stroke: "#94a3b8", fontSize: 11 } as const;

function Empty({ children }: { children: string }) {
  return <p className="py-12 text-center text-sm text-muted-foreground">{children}</p>;
}

function Chart({ children }: { children: React.ReactElement }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      {children}
    </ResponsiveContainer>
  );
}

const tip = {
  contentStyle: {
    background: "rgba(15,23,42,0.94)",
    border: "1px solid rgba(148,163,184,0.25)",
    borderRadius: 10,
    fontSize: 12,
    color: "#e2e8f0",
  },
  labelStyle: { color: "#94a3b8", marginBottom: 2 },
} as const;

export function StepsChart({ data }: { data: { day: string; value: number; source: string }[] }) {
  const avg = data.length ? data.reduce((a, d) => a + d.value, 0) / data.length : 0;
  const source = data[0]?.source ?? "";
  return (
    <Card className="overflow-hidden border-emerald-500/20 bg-gradient-to-b from-emerald-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-emerald-400">Steps per day</CardTitle>
        <CardDescription>
          {source ? `From ${source} — one device per day, sources are never summed together` : "No step records yet"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <Empty>No step records yet.</Empty> : (
          <Chart>
            <AreaChart data={data} margin={{ left: 4, right: 10, top: 8 }}>
              <defs>
                <linearGradient id="gSteps" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.steps} stopOpacity={0.75} />
                  <stop offset="100%" stopColor={C.steps} stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} {...axis} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis width={52} tickLine={false} axisLine={false} {...axis} tickFormatter={(v: number) => compact(v)} />
              <Tooltip {...tip} />
              <ReferenceLine y={avg} stroke={C.stepsSoft} strokeDasharray="4 4" label={{ value: `avg ${compact(avg)}`, fill: C.stepsSoft, fontSize: 11, position: "insideTopRight" }} />
              <Area dataKey="value" name="steps" type="monotone" stroke={C.steps} strokeWidth={2} fill="url(#gSteps)" />
            </AreaChart>
          </Chart>
        )}
      </CardContent>
    </Card>
  );
}

export function WeeklyVolumeChart({ data }: { data: { weekStart: string; sessions: number; minutes: number | null; km: number | null; avgHr: number | null }[] }) {
  return (
    <Card className="overflow-hidden border-indigo-500/20 bg-gradient-to-b from-indigo-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-indigo-400">Weekly training volume</CardTitle>
        <CardDescription>Minutes trained per week, with distance on the right axis</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <Empty>No workouts recorded yet.</Empty> : (
          <Chart>
            <ComposedChart data={data} margin={{ left: 4, right: 10, top: 8 }}>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="weekStart" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} {...axis} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis width={48} tickLine={false} axisLine={false} {...axis} tickFormatter={(v: number) => compact(v)} />
              <YAxis yAxisId="km" orientation="right" width={44} tickLine={false} axisLine={false} {...axis} tickFormatter={(v: number) => num(v, 0)} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="minutes" name="minutes" fill={C.minutes} radius={[4, 4, 0, 0]} maxBarSize={26} fillOpacity={0.85} />
              <Line yAxisId="km" dataKey="km" name="km" type="monotone" stroke={C.distance} strokeWidth={2} dot={{ r: 2.5 }} />
            </ComposedChart>
          </Chart>
        )}
      </CardContent>
    </Card>
  );
}

export function PaceTrendChart({ data }: { data: { day: string; paceMinPerKm: number | null; km: number | null; avgHr: number | null }[] }) {
  const points = data.filter((d) => d.paceMinPerKm !== null);
  return (
    <Card className="overflow-hidden border-amber-500/20 bg-gradient-to-b from-amber-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-amber-400">Run pace</CardTitle>
        <CardDescription>Minutes per km — lower is faster, so the line going down is progress</CardDescription>
      </CardHeader>
      <CardContent>
        {points.length === 0 ? <Empty>No runs with distance recorded yet.</Empty> : (
          <Chart>
            <LineChart data={points} margin={{ left: 4, right: 10, top: 8 }}>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} {...axis} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis width={48} tickLine={false} axisLine={false} {...axis} domain={["auto", "auto"]} tickFormatter={(v: number) => v.toFixed(1)} />
              <Tooltip {...tip} formatter={(v) => [`${Number(v).toFixed(2)} min/km`, "pace"]} />
              <Line dataKey="paceMinPerKm" name="min/km" type="monotone" stroke={C.pace} strokeWidth={2.5} dot={{ r: 3, fill: C.pace }} activeDot={{ r: 5 }} />
            </LineChart>
          </Chart>
        )}
      </CardContent>
    </Card>
  );
}

export function WorkoutHrChart({ data }: { data: { day: string; avgHr: number | null; maxHr: number | null }[] }) {
  const points = data.filter((d) => d.avgHr !== null);
  const avg = points.length ? points.reduce((a, d) => a + (d.avgHr ?? 0), 0) / points.length : 0;
  return (
    <Card className="overflow-hidden border-rose-500/20 bg-gradient-to-b from-rose-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-rose-400">Heart rate per workout</CardTitle>
        <CardDescription>
          Average and peak from the workout itself. At the same pace, a falling average means you are getting fitter.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {points.length === 0 ? <Empty>No workouts with heart-rate data yet.</Empty> : (
          <Chart>
            <ComposedChart data={points} margin={{ left: 4, right: 10, top: 8 }}>
              <defs>
                <linearGradient id="gMaxHr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.hr} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={C.hr} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} {...axis} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis width={44} tickLine={false} axisLine={false} {...axis} domain={["auto", "auto"]} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={avg} stroke={C.hrSoft} strokeDasharray="4 4" />
              <Area dataKey="maxHr" name="max" type="monotone" stroke={C.hr} strokeWidth={1.5} fill="url(#gMaxHr)" />
              <Line dataKey="avgHr" name="avg" type="monotone" stroke={C.hrSoft} strokeWidth={2.5} dot={{ r: 2.5 }} />
            </ComposedChart>
          </Chart>
        )}
      </CardContent>
    </Card>
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
    <Card className="overflow-hidden border-cyan-500/20 bg-gradient-to-b from-cyan-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-cyan-400">Fitness trend</CardTitle>
        <CardDescription>Resting heart rate (bpm) and VO2max (ml/kg/min) — resting HR down and VO2max up both mean progress</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <Empty>No resting heart rate or VO2max records yet.</Empty> : (
          <Chart>
            <LineChart data={data} margin={{ left: 4, right: 10, top: 8 }}>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} {...axis} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis yAxisId="hr" width={40} tickLine={false} axisLine={false} {...axis} domain={["auto", "auto"]} />
              <YAxis yAxisId="vo2" orientation="right" width={40} tickLine={false} axisLine={false} {...axis} domain={["auto", "auto"]} tickFormatter={(v: number) => v.toFixed(0)} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="hr" dataKey="resting" name="resting HR" type="monotone" stroke={C.resting} strokeWidth={2.5} dot={false} connectNulls />
              <Line yAxisId="vo2" dataKey="vo2" name="VO2max" type="monotone" stroke={C.vo2} strokeWidth={2.5} dot={false} connectNulls />
            </LineChart>
          </Chart>
        )}
      </CardContent>
    </Card>
  );
}

export function HeartRateDailyChart({ data }: { data: { day: string; value: number; source: string }[] }) {
  return (
    <Card className="overflow-hidden border-pink-500/20 bg-gradient-to-b from-pink-500/[0.07] to-transparent">
      <CardHeader>
        <CardTitle className="text-pink-400">Daily heart rate</CardTitle>
        <CardDescription>Average of each day&apos;s samples from a single source</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <Empty>No heart-rate records yet.</Empty> : (
          <Chart>
            <AreaChart data={data} margin={{ left: 4, right: 10, top: 8 }}>
              <defs>
                <linearGradient id="gHr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.hr} stopOpacity={0.6} />
                  <stop offset="100%" stopColor={C.hr} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} {...axis} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis width={44} tickLine={false} axisLine={false} {...axis} domain={["auto", "auto"]} />
              <Tooltip {...tip} />
              <Area dataKey="value" name="bpm" type="monotone" stroke={C.hr} strokeWidth={2} fill="url(#gHr)" />
            </AreaChart>
          </Chart>
        )}
      </CardContent>
    </Card>
  );
}
