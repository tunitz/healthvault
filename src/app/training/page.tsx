import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FitnessTrendChart, HeartRateDailyChart, PaceTrendChart, StepsChart, WeeklyVolumeChart, WorkoutHrChart,
} from "@/components/training-charts";
import { FiveKGoalSection, TrainingBlockSection, type WorkoutOption } from "@/components/training/plan-sections";
import { StrengthLogSection, type StrengthWorkoutOption } from "@/components/training/strength-log";
import {
  fiveKAttempts, fiveKBest, heartRateDaily, restingHeartRateDaily, sourceBreakdown, stepsDaily, trendDelta,
  vo2MaxDaily, weeklyTraining, workoutHistory, workoutTotals, workoutTrend, workoutsBetween,
} from "@/db/queries";
import { compact, duration, hrZone, num, plural, workoutLabel } from "@/lib/format";
import { formatDistance, formatPace, formatWeight, formatWeightDelta, resolveUnits } from "@/lib/units";
import { addDays, dayLabel } from "@/lib/day";
import { getProfile, trainingGoal } from "@/lib/services/profile";
import { currentDay, dataFreshness } from "@/lib/services/context";
import { exerciseProgression, listStrengthSessions, recentExercises, strengthContext } from "@/lib/services/strength";
import { MAX_WEEK_OFFSET, weeklySummary } from "@/lib/services/training";
import { currentBlock, nextMonday } from "@/lib/services/training-plan";

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

function WeekStepper({ offset }: { offset: number }) {
  const arrow = "inline-flex size-11 items-center justify-center rounded-md border border-border text-lg leading-none hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  const disabled = "inline-flex size-11 items-center justify-center text-lg leading-none text-muted-foreground/40";
  return (
    <nav aria-label="Week" className="flex items-center gap-1">
      {offset < MAX_WEEK_OFFSET ? (
        <Link className={arrow} href={`/training?week=${offset + 1}`} rel="prev" aria-label="Previous week">
          ‹
        </Link>
      ) : (
        <span className={disabled} aria-hidden>‹</span>
      )}
      {offset === 0 ? (
        <span className="px-2 text-xs font-medium">This week</span>
      ) : (
        <Link className="px-2 text-xs font-medium text-primary underline underline-offset-4" href="/training">
          This week
        </Link>
      )}
      {offset > 0 ? (
        <Link className={arrow} href={`/training?week=${offset - 1}`} rel="next" aria-label="Next week">
          ›
        </Link>
      ) : (
        <span className={disabled} aria-hidden>›</span>
      )}
    </nav>
  );
}

function WeeklyCard({ title, href, value, hint, badge }: {
  title: string; href: string; value: string; hint?: string; badge?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{title}</span>
        {badge}
      </span>
      <span className="num text-lg font-semibold tracking-tight">{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </Link>
  );
}

export default async function TrainingPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const requested = typeof params.week === "string" ? Number.parseInt(params.week, 10) : 0;
  const weekOffset = Number.isFinite(requested) ? Math.min(Math.max(0, Math.trunc(requested)), MAX_WEEK_OFFSET) : 0;
  const profile = getProfile();
  const units = resolveUnits(profile.units);
  const goal = trainingGoal(profile);
  const fresh = dataFreshness();
  const steps = stepsDaily(90);
  const last30 = workoutTotals(30);
  const delta = trendDelta(30);
  const weeklyVolume = weeklyTraining(26);
  const runs = workoutTrend(180);
  const hr = heartRateDaily(90);
  const resting = restingHeartRateDaily(180);
  const vo2 = vo2MaxDaily(365);
  const recent = workoutHistory(25);

  const today = currentDay();
  const attempts = fiveKAttempts(365);
  const bestAttempt = fiveKBest(365);

  // Strength detail: manual sets, grouped by day, never added to the imported workout totals.
  const strengthSessions = listStrengthSessions(14);
  const strengthExercises = recentExercises(20);
  const requestedExercise = typeof params.exercise === "string" ? params.exercise.trim() : "";
  const selectedExercise =
    requestedExercise !== "" && requestedExercise.length <= 120
      ? requestedExercise
      : (strengthExercises[0] ?? null);
  const exerciseOptions =
    selectedExercise !== null && !strengthExercises.includes(selectedExercise)
      ? [selectedExercise, ...strengthExercises]
      : strengthExercises;
  const progression = selectedExercise === null ? [] : exerciseProgression(selectedExercise, 8);
  const strengthWeek = strengthContext();
  const strengthWorkouts: StrengthWorkoutOption[] = workoutsBetween(addDays(today, -13), today).map((workout) => ({
    id: workout.id,
    day: workout.day,
    type: workout.type,
    minutes: workout.minutes,
    km: workout.km,
  }));

  const block = currentBlock();
  const blockWorkouts = block === null ? [] : workoutsBetween(block.weekStart, block.weekEnd);
  const workoutOptions: Record<string, WorkoutOption[]> = {};
  for (const workout of blockWorkouts) {
    (workoutOptions[workout.day] ??= []).push({
      id: workout.id,
      type: workout.type,
      minutes: workout.minutes,
      km: workout.km,
    });
  }

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">Training</h1>
      <p className="text-sm text-muted-foreground">
        Steps, heart rate, pace and volume. One device per day — phone and watch are never added together.
      </p>
      <p className="text-xs text-muted-foreground">
        Apple data through {fresh.lastRecordDay ?? "—"} · workouts through {fresh.lastWorkoutDay ?? "—"}
      </p>
    </div>
  );

  const goalSection = (
    <FiveKGoalSection goal={goal} attempts={attempts} best={bestAttempt} units={units} />
  );

  const blockSection = (
    <TrainingBlockSection
      block={block}
      defaultStart={nextMonday(today)}
      workoutOptions={workoutOptions}
      units={units}
    />
  );

  const strengthSection = (
    <StrengthLogSection
      today={today}
      units={units}
      sessions={strengthSessions}
      exercises={exerciseOptions}
      selectedExercise={selectedExercise}
      progression={progression}
      workoutOptions={strengthWorkouts}
      sessionsThisWeek={strengthWeek.sessionsThisWeek}
      weekOffset={weekOffset}
    />
  );

  if (recent.length === 0 && steps.length === 0 && strengthSessions.length === 0) {
    return (
      <div className="flex flex-col gap-10">
        {header}
        {goalSection}
        {blockSection}
        {strengthSection}
        <section className="flex flex-col items-start gap-3">
          <p className="max-w-prose text-sm text-muted-foreground">
            No Apple training data yet. Upload your <code>Export.zip</code> and this page fills in with steps,
            heart rate, pace and weekly volume.
          </p>
          <Link className="text-sm text-primary underline underline-offset-4" href="/uploads">Go to Import</Link>
        </section>
      </div>
    );
  }

  const weekly = weeklySummary(weekOffset);
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
      {header}

      <section className="flex flex-col gap-3" aria-labelledby="weekly-summary-title">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h2 id="weekly-summary-title" className="text-sm font-medium">Weekly training &amp; recovery</h2>
            <p className="text-xs text-muted-foreground">
              {dayLabel(weekly.weekStart)} – {dayLabel(weekly.weekEnd)} · {weekly.timezone}
            </p>
          </div>
          <WeekStepper offset={weekOffset} />
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <WeeklyCard
            title="Runs"
            href="#recent-workouts"
            value={plural(weekly.runs.count, "run")}
            hint={`${formatDistance(weekly.runs.km, units)} · ${duration(weekly.runs.minutes * 60)}${
              weekly.runs.bestPaceMinPerKm === null ? "" : ` · best ${formatPace(weekly.runs.bestPaceMinPerKm, units)}`
            }`}
          />
          <WeeklyCard
            title="Strength"
            href="#strength-log"
            value={plural(weekly.strength.appleSessions, "Apple session")}
            hint={`${plural(weekly.strength.loggedSets, "logged set")} · ${plural(weekly.strength.exercises, "exercise")}`}
          />
          <WeeklyCard
            title="Steps"
            href="#steps"
            value={`${compact(Math.round(weekly.steps.avgPerDay))} / day`}
            hint={`${plural(weekly.steps.daysWithData, "day")} with data`}
          />
          <WeeklyCard
            title="Sleep"
            href="/"
            value={weekly.sleep.nights ? `${num(weekly.sleep.avgPerNight, 1)} h` : "—"}
            hint={plural(weekly.sleep.nights, "night")}
          />
          <WeeklyCard
            title="Resting HR"
            href="#heart-rate"
            value={weekly.restingHr.avg === null ? "—" : `${num(weekly.restingHr.avg, 0)} bpm`}
            hint={weekly.restingHr.latest === null
              ? "no readings"
              : `latest ${num(weekly.restingHr.latest, 0)} bpm${weekly.restingHr.latestDay ? ` · ${weekly.restingHr.latestDay}` : ""}`}
          />
          <WeeklyCard
            title="Weight"
            href="/profile"
            value={formatWeight(weekly.weight.avgKg, units)}
            hint={`${plural(weekly.weight.readings, "reading")}${
              weekly.weight.changeKg === null ? "" : ` · ${formatWeightDelta(weekly.weight.changeKg, units)}`
            }`}
            badge={weekly.weight.sparse ? (
              <Badge variant="outline" className="shrink-0">sparse data</Badge>
            ) : null}
          />
        </div>

        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Apple data through {weekly.freshness.lastRecordDay ?? "—"} · workouts through{" "}
            {weekly.freshness.lastWorkoutDay ?? "—"}
          </span>
          {weekly.freshness.stale ? (
            <Badge variant="destructive" title="Apple record data ends before this week">
              stale
            </Badge>
          ) : null}
        </p>
      </section>

      {goalSection}

      {blockSection}

      {strengthSection}

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

      <div id="steps" className="scroll-mt-20">
        <StepsChart data={steps} />
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <WeeklyVolumeChart data={weeklyVolume} units={units} />
        <WorkoutHrChart data={runs} />
        <PaceTrendChart data={runs} units={units} />
        <FitnessTrendChart resting={resting} vo2={vo2} />
      </div>

      <div id="heart-rate" className="scroll-mt-20">
        <HeartRateDailyChart data={hr} />
      </div>

      <section id="recent-workouts" className="flex scroll-mt-20 flex-col gap-3">
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
                  <TableCell><span className="block max-w-[5.5rem] truncate sm:max-w-[7.5rem] md:max-w-none">{workoutLabel(w.type)}</span></TableCell>
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
