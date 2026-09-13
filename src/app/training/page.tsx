import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FitnessTrendChart, HeartRateDailyChart, PaceTrendChart, StepsChart, WeeklyVolumeChart, WorkoutHrChart,
} from "@/components/training-charts";
import {
  heartRateDaily, restingHeartRateDaily, sourceBreakdown, stepsDaily, trendDelta, vo2MaxDaily,
  weeklyTraining, workoutHistory, workoutTotals, workoutTrend,
} from "@/db/queries";
import { compact, hrZone, minutes, num, workoutLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

function StatCard({ title, value, hint, accent, delta }: {
  title: string; value: string; hint?: string; accent: string; delta?: string | null;
}) {
  return (
    <Card className={`overflow-hidden border-l-4 ${accent} bg-card/60`}>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {delta ? <p className="text-xs font-medium text-muted-foreground">{delta}</p> : null}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

const pct = (v: number | null, unit = "%") => (v === null ? "no comparison" : `${v >= 0 ? "+" : ""}${num(v, 0)}${unit} vs previous 30 days`);

export default function TrainingPage() {
  const steps = stepsDaily(90);
  const last30 = workoutTotals(30);
  const delta = trendDelta(30);
  const weekly = weeklyTraining(26);
  const runs = workoutTrend(180);
  const hr = heartRateDaily(90);
  const resting = restingHeartRateDaily(180);
  const vo2 = vo2MaxDaily(365);
  const recent = workoutHistory(25);

  if (recent.length === 0 && steps.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Training</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          No training data yet. Upload your Apple Health <code>Export.zip</code> and this page fills in with
          steps, heart rate, pace and weekly volume.
        </p>
        <Link className="text-sm text-emerald-400 underline" href="/uploads">Go to upload</Link>
      </div>
    );
  }

  const stepAvg = steps.length ? steps.reduce((a, d) => a + d.value, 0) / steps.length : 0;
  const restingLatest = resting.at(-1)?.value;
  const restingFirst = resting[0]?.value;
  const restingDelta = restingLatest !== undefined && restingFirst !== undefined ? restingLatest - restingFirst : null;
  const vo2Latest = vo2.at(-1)?.value;
  const vo2First = vo2[0]?.value;
  const vo2Delta = vo2Latest !== undefined && vo2First !== undefined ? vo2Latest - vo2First : null;
  // one row per device (a device records both metrics, and two badges with the same label
  // were colliding as React keys)
  const deviceMap = new Map<string, { source: string; steps: number; hr: number }>();
  for (const s of sourceBreakdown("HKQuantityTypeIdentifierStepCount")) {
    deviceMap.set(s.source, { source: s.source, steps: s.records, hr: 0 });
  }
  for (const s of sourceBreakdown("HKQuantityTypeIdentifierHeartRate")) {
    const row = deviceMap.get(s.source) ?? { source: s.source, steps: 0, hr: 0 };
    row.hr = s.records;
    deviceMap.set(s.source, row);
  }
  const devices = [...deviceMap.values()].sort((a, b) => b.hr + b.steps - (a.hr + a.steps));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Training</h1>
        <p className="text-sm text-muted-foreground">
          Steps, heart rate, pace and volume. Each day is read from a single device — phone and watch overlap in
          time, so adding them together would inflate every number.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          accent="border-l-emerald-500"
          title="Steps / day (90d)"
          value={compact(stepAvg)}
          hint={steps[0] ? `source: ${steps[0].source}` : undefined}
        />
        <StatCard
          accent="border-l-violet-500"
          title="Distance (30d)"
          value={`${num(last30.km ?? 0, 1)} km`}
          delta={pct(delta.kmChangePct)}
          hint={`${num(last30.sessions)} sessions · ${minutes((last30.minutes ?? 0) * 60)}`}
        />
        <StatCard
          accent="border-l-rose-500"
          title="Avg workout HR (30d)"
          value={last30.avgHr === null ? "—" : `${num(last30.avgHr, 0)} bpm`}
          delta={delta.avgHrChange === null ? null : `${delta.avgHrChange >= 0 ? "+" : ""}${num(delta.avgHrChange, 1)} bpm vs previous 30 days`}
          hint={last30.maxHr === null ? undefined : `peak ${num(last30.maxHr, 0)} bpm`}
        />
        <StatCard
          accent="border-l-cyan-500"
          title="Resting HR"
          value={restingLatest === undefined ? "—" : `${num(restingLatest, 0)} bpm`}
          delta={restingDelta === null ? null : `${restingDelta >= 0 ? "+" : ""}${num(restingDelta, 1)} bpm since ${resting[0]?.day}`}
          hint={vo2Latest === undefined ? undefined : `VO2max ${num(vo2Latest, 1)}${vo2Delta === null ? "" : ` (${vo2Delta >= 0 ? "+" : ""}${num(vo2Delta, 1)})`}`}
        />
      </div>

      <StepsChart data={steps} />

      <div className="grid gap-6 lg:grid-cols-2">
        <WeeklyVolumeChart data={weekly} />
        <WorkoutHrChart data={runs} />
        <PaceTrendChart data={runs} />
        <FitnessTrendChart resting={resting} vo2={vo2} />
      </div>

      <HeartRateDailyChart data={hr} />

      <Card>
        <CardHeader>
          <CardTitle>Recent workouts</CardTitle>
          <CardDescription>
            Pace is derived from distance and duration; the heart-rate colour is the intensity band.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">Distance</TableHead>
                <TableHead className="text-right">Pace</TableHead>
                <TableHead className="text-right">Avg HR</TableHead>
                <TableHead className="text-right">Max HR</TableHead>
                <TableHead className="text-right">Energy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((w, i) => {
                const zone = hrZone(w.avgHr);
                return (
                  <TableRow key={`${w.startDate}-${i}`}>
                    <TableCell className="tabular-nums">{w.day}</TableCell>
                    <TableCell>{workoutLabel(w.type)}</TableCell>
                    <TableCell className="text-right tabular-nums">{w.minutes === null ? "—" : `${num(w.minutes, 0)} min`}</TableCell>
                    <TableCell className="text-right tabular-nums text-violet-300">
                      {w.km === null ? "—" : `${num(w.km, 2)} km`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-amber-300">
                      {w.paceMinPerKm === null ? "—" : `${num(w.paceMinPerKm, 2)} /km`}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${zone.className}`}>
                      {w.avgHr === null ? "—" : `${num(w.avgHr, 0)} ${zone.label}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-rose-300">
                      {w.maxHr === null ? "—" : num(w.maxHr, 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w.kcal === null ? "—" : `${num(w.kcal, 0)} kcal`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where the numbers come from</CardTitle>
          <CardDescription>
            Devices that recorded these metrics, so a surprising total can be traced to its origin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {devices.map((d) => (
              <Badge key={d.source} variant="secondary" className="gap-1">
                <span className="text-emerald-400">{compact(d.steps)} steps</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-rose-400">{compact(d.hr)} heart rate</span>
                <span className="text-muted-foreground">·</span>
                {d.source}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Only one device is counted per day — the one with the most samples — so these are never added
            together.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
