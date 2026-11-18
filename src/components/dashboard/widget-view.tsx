import type { ReactNode } from "react";
import { allWorkouts } from "@/db/queries";
import type { HealthContext } from "@/lib/services/context";
import type { Units } from "@/lib/units";
import { formatDistance, formatPace, formatWeight, formatWeightDelta, resolveUnits } from "@/lib/units";
import { compact, instant, num, plural } from "@/lib/format";
import { dayHeading } from "@/lib/day";
import { SleepStackChart } from "@/components/sleep-stack-chart";
import { SeriesChart } from "./series-chart";
import { supplementHint } from "./data";
import type { DashboardData, RangeData } from "./widget-data";
import type { WidgetId, WidgetPreference } from "./registry";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="num text-lg font-semibold tracking-tight">{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Empty({ children = "No data in this range" }: { children?: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function SimpleTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {head.map((cell) => (
              <th key={cell} scope="col" className="py-2 pr-3 text-xs font-medium text-muted-foreground">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-border/60 last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="num py-2 pr-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function nextLabel(context: HealthContext): string | null {
  const next = context.nextSupplement;
  if (!next) return null;
  return `${next.supplement.name}${next.schedule.time ? ` at ${next.schedule.time}` : ""}`;
}

function nutritionView(context: HealthContext, display: WidgetPreference["display"]): ReactNode {
  const { totals, targets, remaining, entries } = context.nutrition;
  if (entries.length === 0) return <Empty>No meals logged today</Empty>;
  const rows: { label: string; total: string; target: string; left: string }[] = [
    { label: "Calories", total: `${num(totals.kcal, 0)} kcal`, target: `${num(targets.kcal, 0)}`, left: `${num(remaining.kcal, 0)}` },
    { label: "Protein", total: `${num(totals.proteinG, 0)} g`, target: `${num(targets.proteinG, 0)} g`, left: `${num(remaining.proteinG, 0)} g` },
    { label: "Carbs", total: `${num(totals.carbsG, 0)} g`, target: `${num(targets.carbsG, 0)} g`, left: `${num(remaining.carbsG, 0)} g` },
    { label: "Fat", total: `${num(totals.fatG, 0)} g`, target: `${num(targets.fatG, 0)} g`, left: `${num(remaining.fatG, 0)} g` },
    { label: "Fibre", total: `${num(totals.fibreG, 0)} g`, target: `${num(targets.fibreG, 0)} g`, left: `${num(remaining.fibreG, 0)} g` },
  ];
  if (display === "table") {
    return (
      <SimpleTable
        caption="Today's nutrition against targets"
        head={["Macro", "Logged", "Target", "Remaining"]}
        rows={rows.map((row) => [row.label, row.total, row.target, row.left])}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
      <Stat label="Calories left" value={remaining.kcal < 0 ? `${num(Math.abs(remaining.kcal), 0)} over` : `${num(remaining.kcal, 0)}`} hint={`of ${num(targets.kcal, 0)} kcal`} />
      <Stat label="Protein" value={`${num(totals.proteinG, 0)} g`} hint={`target ${num(targets.proteinG, 0)} g`} />
      <Stat label="Meals" value={String(entries.length)} hint={dayHeading(context.today)} />
    </div>
  );
}

function activityView(range: RangeData, display: WidgetPreference["display"]): ReactNode {
  const stepsTotal = range.steps.reduce((sum, point) => sum + point.value, 0);
  if (display === "line" || display === "area") {
    return (
      <SeriesChart
        data={range.steps.map((point) => ({ day: point.day, value: point.value }))}
        kind={display}
        label="Steps"
        ariaLabel={`Steps per day over ${range.days} days`}
      />
    );
  }
  if (display === "bars") {
    return (
      <SeriesChart
        data={range.activitySeries.map((point) => ({ day: point.day, value: point.activeEnergy ?? 0 }))}
        kind="bars"
        label="Active energy (kcal)"
        unit="kcal"
        colorVar="var(--chart-4)"
        ariaLabel={`Active energy per day over ${range.days} days`}
      />
    );
  }
  if (display === "table") {
    const energyByDay = new Map(range.activitySeries.map((point) => [point.day, point]));
    return (
      <SimpleTable
        caption={`Daily activity over ${range.days} days`}
        head={["Day", "Steps", "Active kcal", "Exercise min"]}
        rows={range.steps.map((point) => {
          const extra = energyByDay.get(point.day);
          return [
            point.day.slice(5),
            compact(point.value),
            extra?.activeEnergy === null || extra?.activeEnergy === undefined ? "—" : num(extra.activeEnergy, 0),
            extra?.exerciseTime === null || extra?.exerciseTime === undefined ? "—" : num(extra.exerciseTime, 0),
          ];
        })}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
      <Stat label="Steps" value={compact(stepsTotal)} hint={`${plural(range.steps.length, "day")}`} />
      <Stat label="Active energy" value={`${compact(range.activity.energy)} kcal`} />
      <Stat label="Exercise" value={`${num(range.activity.exerciseMinutes, 0)} min`} />
      <Stat label="Summary days" value={num(range.activity.days, 0)} />
    </div>
  );
}

function supplementsView(context: HealthContext, range: RangeData, display: WidgetPreference["display"]): ReactNode {
  const checklist = context.supplements;
  const hint = supplementHint(checklist, nextLabel(context));
  if (checklist.total === 0) return <Empty>No supplements scheduled today</Empty>;
  if (display === "adherence") {
    const rows = range.adherence.map((item) => {
      const latest = item.weeks[item.weeks.length - 1];
      return [item.name, `${latest?.elapsedPct ?? 0}%`, `${latest?.elapsedTakenDays ?? 0}/${latest?.elapsedScheduledDays ?? 0}`];
    });
    return (
      <SimpleTable caption="Supplement adherence, current week" head={["Supplement", "Elapsed", "Taken / scheduled"]} rows={rows} />
    );
  }
  if (display === "checklist") {
    return (
      <ul className="divide-y divide-border text-sm">
        {checklist.items.map((item) => (
          <li key={item.supplement.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 truncate">
              {item.supplement.name}
              {item.schedule.time ? <span className="text-muted-foreground"> · {item.schedule.time}</span> : null}
            </span>
            {/* Text status, never colour alone. */}
            <span className="shrink-0 text-xs font-medium">{item.logged ? "Taken" : "Pending"}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (display === "table") {
    return (
      <SimpleTable
        caption="Today's supplement checklist"
        head={["Supplement", "Scheduled", "Status"]}
        rows={checklist.items.map((item) => [
          item.supplement.name,
          item.schedule.time ?? "Any time",
          item.logged ? "Taken" : "Pending",
        ])}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4">
      <Stat label="Taken today" value={`${checklist.taken} / ${checklist.total}`} hint={hint} />
      <Stat label="Remaining" value={String(checklist.total - checklist.taken)} hint="Scheduled today" />
    </div>
  );
}

function measurementsView(data: DashboardData, range: RangeData, units: Units, display: WidgetPreference["display"]): ReactNode {
  const { latestWeight, latestBodyFat, latestWaist } = data.measurements;
  if (display === "line" || display === "area") {
    return (
      <SeriesChart
        data={range.measurements.map((point) => ({ day: point.day, value: Number(point.value.toFixed(2)) }))}
        kind={display}
        label="Weight (kg)"
        unit="kg"
        colorVar="var(--chart-2)"
        ariaLabel={`Weight measurements over ${range.days} days`}
      />
    );
  }
  if (display === "table") {
    if (range.measurements.length === 0) return <Empty>No measurements in this range</Empty>;
    return (
      <SimpleTable
        caption="Weight measurements"
        head={["Day", "Weight", "Source"]}
        rows={range.measurements.map((point) => [point.day, formatWeight(point.value, units), point.source])}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
      <Stat label="Weight" value={formatWeight(latestWeight?.value, units)} hint={latestWeight?.source ?? "not logged"} />
      <Stat label="Body fat" value={latestBodyFat ? `${num(latestBodyFat.value, 1)}%` : "—"} />
      <Stat label="Waist" value={latestWaist ? `${num(latestWaist.value, 1)} cm` : "—"} />
    </div>
  );
}

function sleepView(range: RangeData, display: WidgetPreference["display"]): ReactNode {
  const nights = range.sleepDuration;
  const total = nights.reduce((sum, point) => sum + point.value, 0);
  const avg = nights.length ? total / nights.length : 0;
  if (nights.length === 0) return <Empty>No sleep data in this range</Empty>;
  if (display === "stages") {
    return <SleepStackChart data={range.sleepRows} />;
  }
  if (display === "duration") {
    return (
      <SeriesChart
        data={nights}
        kind="area"
        label="Asleep (h)"
        unit="h"
        colorVar="var(--chart-2)"
        ariaLabel={`Hours asleep per night over ${range.days} days`}
      />
    );
  }
  if (display === "table") {
    const stagesByDay = new Map<string, string[]>();
    for (const row of range.sleepRows) {
      const group = stagesByDay.get(row.day) ?? [];
      group.push(`${stageName(row.stage)} ${num(row.hours, 1)}h`);
      stagesByDay.set(row.day, group);
    }
    return (
      <SimpleTable
        caption="Sleep by night"
        head={["Night", "Asleep", "Stages"]}
        rows={nights.map((point) => [point.day, `${num(point.value, 1)} h`, (stagesByDay.get(point.day) ?? []).join(", ") || "—"])}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
      <Stat label="Average asleep" value={`${num(avg, 1)} h`} hint={`${plural(nights.length, "night")}`} />
      <Stat label="Total asleep" value={`${num(total, 0)} h`} />
      <Stat label="Last night" value={`${num(nights[nights.length - 1]?.value ?? 0, 1)} h`} />
    </div>
  );
}

function stageName(stage: number): string {
  return { 1: "In bed", 2: "Asleep", 3: "Awake", 4: "Core", 5: "Deep", 6: "REM" }[stage] ?? `Stage ${stage}`;
}

function weightView(context: HealthContext, range: RangeData, units: Units, display: WidgetPreference["display"]): ReactNode {
  const latest = context.weight.latest;
  if (display === "line" || display === "area") {
    return (
      <SeriesChart
        data={range.weight.points.map((point) => ({ day: point.day, value: Number(point.value.toFixed(2)) }))}
        kind={display}
        label="Weight (kg)"
        unit="kg"
        colorVar="var(--chart-3)"
        ariaLabel={`Weight trend over ${range.days} days`}
      />
    );
  }
  if (display === "table") {
    if (range.weight.points.length === 0) return <Empty>No weight readings in this range</Empty>;
    return (
      <SimpleTable
        caption="Weight readings"
        head={["Day", "Weight", "Source"]}
        rows={range.weight.points.map((point) => [point.day, formatWeight(point.value, units), point.source])}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
      <Stat label="Latest" value={formatWeight(latest?.value, units)} hint={latest?.source ?? "not logged"} />
      <Stat label={`Change (${range.days}d)`} value={formatWeightDelta(range.weight.changeKg, units)} />
      <Stat label="Goal" value={formatWeight(context.weight.goalKg, units)} />
    </div>
  );
}

function workoutsView(range: RangeData, units: Units, display: WidgetPreference["display"]): ReactNode {
  const totals = range.workoutTotals;
  if (display === "bars") {
    const rows = range.workoutTypes.map((row) => ({ day: row.type, value: row.sessions }));
    return (
      <SeriesChart
        data={rows}
        kind="bars"
        label="Sessions"
        colorVar="var(--chart-5)"
        ariaLabel={`Workout sessions by type over ${range.days} days`}
      />
    );
  }
  if (display === "table") {
    const rows = allWorkouts({ limit: 10 });
    if (rows.length === 0) return <Empty>No workouts recorded</Empty>;
    return (
      <SimpleTable
        caption="Recent workouts"
        head={["Day", "Activity", "Distance", "Minutes"]}
        rows={rows.map((row) => [
          row.day,
          row.type.replace(/^HKWorkoutActivityType/, ""),
          formatDistance(row.distanceKm, units),
          row.durationSeconds === null ? "—" : num(row.durationSeconds / 60, 0),
        ])}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
      <Stat label="Sessions" value={num(totals.sessions, 0)} />
      <Stat label="Distance" value={formatDistance(totals.km, units)} />
      <Stat label="Duration" value={`${num(totals.minutes ?? 0, 0)} min`} />
      <Stat label="Energy" value={`${num(totals.kcal ?? 0, 0)} kcal`} />
    </div>
  );
}

function trainingView(context: HealthContext, display: WidgetPreference["display"]): ReactNode {
  const weekly = context.training.weekly;
  const rows: [string, string][] = [
    ["Week", `${weekly.weekStart} to ${weekly.weekEnd}`],
    ["Runs", `${plural(weekly.runs.count, "run")} · ${formatDistance(weekly.runs.km, resolveUnits(context.profile.units))}`],
    ["Best pace", formatPace(weekly.runs.bestPaceMinPerKm, resolveUnits(context.profile.units))],
    ["Strength", `${plural(weekly.strength.appleSessions, "Apple session")} · ${plural(weekly.strength.loggedSets, "set")}`],
    ["Steps / day", `${num(weekly.steps.avgPerDay, 0)} over ${plural(weekly.steps.daysWithData, "day")}`],
    ["Sleep", `${num(weekly.sleep.avgPerNight, 1)} h over ${plural(weekly.sleep.nights, "night")}`],
    ["Resting HR", weekly.restingHr.avg === null ? "—" : `${num(weekly.restingHr.avg, 0)} bpm`],
  ];
  if (display === "table") {
    return <SimpleTable caption="This week's training summary" head={["Metric", "Value"]} rows={rows.map(([a, b]) => [a, b])} />;
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
      <Stat label="Runs this week" value={String(weekly.runs.count)} hint={formatDistance(weekly.runs.km, resolveUnits(context.profile.units))} />
      <Stat label="Strength sets" value={String(weekly.strength.loggedSets)} />
      <Stat label="Steps / day" value={num(weekly.steps.avgPerDay, 0)} />
    </div>
  );
}

function importsView(context: HealthContext, data: DashboardData, display: WidgetPreference["display"]): ReactNode {
  const last = data.lastSuccess;
  if (display === "table") {
    if (data.attempts.length === 0) return <Empty>No import attempts yet</Empty>;
    return (
      <SimpleTable
        caption="Recent import attempts"
        head={["File", "Status", "New rows", "Finished"]}
        rows={data.attempts.map((attempt) => [
          attempt.filename,
          attempt.status,
          num(attempt.inserted, 0),
          instant(attempt.finishedAtMs, context.timezone),
        ])}
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4">
      <Stat
        label="Last successful import"
        value={last ? instant(last.finishedAtMs, context.timezone) : "—"}
        hint={last ? `${last.filename} · ${plural(last.inserted, "new row")}` : "No completed import"}
      />
      <Stat label="Records" value={compact(context.data.counts.records)} hint={plural(context.data.counts.uploads, "import attempt")} />
    </div>
  );
}

/** Render one widget's chosen view. All views read the same already-loaded data object. */
export function WidgetView({
  id,
  pref,
  context,
  data,
}: {
  id: WidgetId;
  pref: WidgetPreference;
  context: HealthContext;
  data: DashboardData;
}) {
  const units = resolveUnits(context.profile.units);
  const range = data.byRange[pref.range] as RangeData;
  switch (id) {
    case "nutrition": return nutritionView(context, pref.display);
    case "activity": return activityView(range, pref.display);
    case "supplements": return supplementsView(context, range, pref.display);
    case "measurements": return measurementsView(data, range, units, pref.display);
    case "sleep": return sleepView(range, pref.display);
    case "weight": return weightView(context, range, units, pref.display);
    case "workouts": return workoutsView(range, units, pref.display);
    case "training": return trainingView(context, pref.display);
    case "imports": return importsView(context, data, pref.display);
  }
}
