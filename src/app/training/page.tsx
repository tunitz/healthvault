import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FitnessTrendChart, HeartRateDailyChart, PaceTrendChart, StepsChart, WeeklyVolumeChart, WorkoutHrChart,
} from "@/components/training-charts";
import {
  heartRateDaily, restingHeartRateDaily, sourceBreakdown, stepsDaily, trendDelta, vo2MaxDaily,
  weeklyTraining, workoutHistory, workoutTotals, workoutTrend,
} from "@/db/queries";
import { compact, duration, hrZone, num, plural, workoutLabel } from "@/lib/format";
import { formatDistance, formatPace, resolveUnits } from "@/lib/units";
import { getProfile } from "@/lib/services/profile";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Training" };

function Metric({ title, value, hint, delta }: {
  title: string; value: string; hint?: string; delta?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="num text-2xl font-semibold tracking-tight">{value}</p>
      {delta ? <p className="text-xs text-muted-foreground">{delta}</p> : null}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const pct = (v: number | null, unit = "%") => (v === null ? "no comparison" : `${v >= 0 ? "+" : ""}${num(v, 0)}${unit} vs previous 30 days`);

export default function TrainingPage() {
  const units = resolveUnits(getProfile().units);
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
        <Link className="text-sm text-primary underline underline-offset-4" href="/uploads">Go to Import</Link>
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
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Training</h1>
        <p className="text-sm text-muted-foreground">
          Steps, heart rate, pace and volume. One device per day — phone and watch are never added together.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
        <Metric
          title="Steps / day (90d)"
          value={compact(Math.round(stepAvg))}
          hint={steps.at(-1) ? `source: ${steps.at(-1)!.source}` : undefined}
        />
        <Metric
          title="Distance (30d)"
          value={formatDistance(last30.km ?? 0, units)}
          delta={pct(delta.kmChangePct)}
          hint={`${plural(last30.sessions, "session")} · ${duration((last30.minutes ?? 0) * 60)}`}
        />
        <Metric
          title="Avg workout HR (30d)"
          value={last30.avgHr === null ? "—" : `${num(last30.avgHr, 0)} bpm`}
          delta={delta.avgHrChange === null ? null : `${delta.avgHrChange >= 0 ? "+" : ""}${num(delta.avgHrChange, 1)} bpm vs previous 30 days`}
          hint={last30.maxHr === null ? undefined : `peak ${num(last30.maxHr, 0)} bpm`}
        />
        <Metric
          title="Resting HR"
          value={restingLatest === undefined ? "—" : `${num(restingLatest, 0)} bpm`}
          delta={restingDelta === null ? null : `${restingDelta >= 0 ? "+" : ""}${num(restingDelta, 1)} bpm since ${resting[0]?.day}`}
          hint={vo2Latest === undefined ? undefined : `VO2max ${num(vo2Latest, 1)}${vo2Delta === null ? "" : ` (${vo2Delta >= 0 ? "+" : ""}${num(vo2Delta, 1)})`}`}
        />
      </div>

      <StepsChart data={steps} />

      <div className="grid gap-10 lg:grid-cols-2">
        <WeeklyVolumeChart data={weekly} units={units} />
        <WorkoutHrChart data={runs} />
        <PaceTrendChart data={runs} units={units} />
        <FitnessTrendChart resting={resting} vo2={vo2} />
      </div>

      <HeartRateDailyChart data={hr} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Recent workouts</h2>
          <p className="text-xs text-muted-foreground">
            Pace from distance and duration; the dot is the intensity band.
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead>Activity</TableHead>
              <TableHead className="text-right">Time</TableHead>
              <TableHead className="text-right">Distance</TableHead>
              <TableHead className="hidden text-right md:table-cell">Pace</TableHead>
              <TableHead className="hidden text-right md:table-cell">Avg HR</TableHead>
              <TableHead className="hidden text-right md:table-cell">Max HR</TableHead>
              <TableHead className="hidden text-right md:table-cell">Energy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.map((w, i) => {
              const zone = hrZone(w.avgHr);
              return (
                <TableRow key={`${w.startDate}-${i}`}>
                  <TableCell className="num"><span className="md:hidden">{w.day.slice(5)}</span><span className="hidden md:inline">{w.day}</span></TableCell>
                  <TableCell><span className="block max-w-[7.5rem] truncate md:max-w-none">{workoutLabel(w.type)}</span></TableCell>
                  <TableCell className="num text-right">{w.minutes === null ? "—" : `${num(w.minutes, 0)} min`}</TableCell>
                  <TableCell className="num text-right">
                    {formatDistance(w.km, units, 2)}
                  </TableCell>
                  <TableCell className="num hidden text-right md:table-cell">
                    {formatPace(w.paceMinPerKm, units)}
                  </TableCell>
                  <TableCell className="num hidden text-right md:table-cell">
                    {w.avgHr === null ? (
                      "—"
                    ) : (
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <span aria-hidden className={`size-2 shrink-0 rounded-full ${zone.dot}`} />
                        <span>
                          {num(w.avgHr, 0)} {zone.label}
                        </span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="num hidden text-right md:table-cell">
                    {w.maxHr === null ? "—" : num(w.maxHr, 0)}
                  </TableCell>
                  <TableCell className="num hidden text-right md:table-cell">
                    {w.kcal === null ? "—" : `${num(w.kcal, 0)} kcal`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Where the numbers come from</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {devices.map((d) => (
            <Badge
              key={d.source}
              variant="outline"
              className="h-auto max-w-full flex-wrap gap-1.5 whitespace-normal px-2.5 py-1 font-normal break-words"
            >
              <span className="num text-foreground">{compact(d.steps)} steps</span>
              <span className="text-muted-foreground">·</span>
              <span className="num text-foreground">{compact(d.hr)} heart rate</span>
              <span className="text-muted-foreground">·</span>
              <span className="min-w-0">{d.source}</span>
            </Badge>
          ))}
        </div>
      </section>
    </div>
  );
}
