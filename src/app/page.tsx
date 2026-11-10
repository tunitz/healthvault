import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { ActivityChart } from "@/components/activity-chart";
import { SleepStackChart } from "@/components/sleep-stack-chart";
import { StepsAreaChart } from "@/components/steps-area-chart";
import {
  activitySummarySeries,
  activitySummaryTotals,
  hasMoveMinutes,
  sleepByDayStage,
  stepsDaily,
} from "@/db/queries";
import { healthvaultContext } from "@/lib/services/context";
import { compact, instant, num, plural } from "@/lib/format";
import { dayLabel, daysBetween } from "@/lib/day";

export const dynamic = "force-dynamic";

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num text-2xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function TodayCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num text-xl font-semibold tracking-tight">{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export default function DashboardPage() {
  const context = healthvaultContext();
  const totals = context.data.counts;
  const timezone = context.timezone;

  if (totals.records === 0) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Logo size={40} />
        <h1 className="text-2xl font-semibold tracking-tight">No health data yet</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Export your data on the iPhone: Health app → your picture → Export All Health Data, then
          import the resulting <code>Export.zip</code> on the Import page.
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          {context.profile.started
            ? "Your profile is set. Import an export to fill the dashboard."
            : "Set up your profile now so the agent has your height, birth date and goals on file."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/uploads">Import an export</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/profile">{context.profile.started ? "View profile" : "Set up profile"}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const activity = activitySummaryTotals(30);
  const showMoveMinutes = hasMoveMinutes();
  const stepSeries = stepsDaily(30);
  const sleepSeries = sleepByDayStage(90);
  const activitySeries = activitySummarySeries(30);

  const lastStep = stepSeries.at(-1);
  const stepsToday = lastStep?.day === context.today ? lastStep.value : null;

  const nights = new Map<string, number>();
  for (const row of sleepSeries) {
    if (row.stage === 2 || row.stage === 4 || row.stage === 5 || row.stage === 6) {
      nights.set(row.day, (nights.get(row.day) ?? 0) + row.hours);
    }
  }
  const lastNight = [...nights.entries()].sort((a, b) => b[0].localeCompare(a[0]))[0];
  const lastNightIsRecent = lastNight ? daysBetween(lastNight[0], context.today) <= 1 : false;

  const remainingKcal = context.nutrition.remaining.kcal;
  const weight = context.weight.latest;
  const goal = context.weight.goalKg;
  const next = context.nextSupplement;
  const supplements = context.supplements;
  const lastUpload = context.data.lastUpload;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {plural(totals.records, "record", "records", compact(totals.records))} · {plural(totals.workouts, "workout")} ·{" "}
          {plural(totals.summaries, "activity day")} · {plural(totals.uploads, "upload")}
        </p>
      </div>

      {!context.profile.started ? (
        <Link href="/profile" className="text-sm text-primary underline underline-offset-4">
          Complete your profile
        </Link>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Today</h2>
          <p className="text-xs text-muted-foreground">{dayLabel(context.today)} · {context.today}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TodayCard
            label="Calories"
            value={remainingKcal < 0 ? `${num(Math.abs(remainingKcal), 0)} over` : `${num(remainingKcal, 0)} left`}
            hint={`${num(context.nutrition.totals.kcal, 0)} / ${num(context.nutrition.targets.kcal, 0)} kcal · ${num(context.nutrition.totals.proteinG, 0)} g protein`}
          />
          <TodayCard
            label="Weight"
            value={weight ? `${num(weight.value)} kg` : "—"}
            hint={[
              weight ? weight.source === "manual" ? "manual" : "Apple" : "not logged",
              goal !== null ? `goal ${num(goal)} kg` : null,
              context.weight.change7dKg !== null
                ? `${context.weight.change7dKg >= 0 ? "+" : ""}${num(context.weight.change7dKg)} kg / 7d`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <TodayCard
            label="Supplements"
            value={`${supplements.taken} / ${supplements.total}`}
            hint={
              next
                ? `Next: ${next.supplement.name}${next.schedule.time ? ` at ${next.schedule.time}` : ""}`
                : supplements.total > 0
                  ? "All taken"
                  : "None scheduled"
            }
          />
          <TodayCard
            label="Movement"
            value={stepsToday === null ? "—" : `${compact(stepsToday)} steps`}
            hint={
              lastNight && lastNightIsRecent
                ? `${num(lastNight[1], 1)} h sleep (${lastNight[0].slice(5)})`
                : "No recent sleep"
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {lastUpload
            ? `Last import ${instant(lastUpload.finishedAtMs, timezone)} · ${plural(lastUpload.inserted, "new row")}`
            : "No import yet"}
          {context.data.lastRecordDay ? ` · latest data ${context.data.lastRecordDay}` : ""}
        </p>
      </section>

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
        <Metric
          label="Steps (last 30 days)"
          value={compact(context.training.steps.totalInWindow)}
          hint={`${num(context.training.steps.avgPerDay)} / day average · ${compact(context.training.steps.allTimeSteps)} all time`}
        />
        <Metric
          label="Sleep (last 30 days)"
          value={`${num(context.training.sleep.avgPerNight)} h`}
          hint={`${plural(context.training.sleep.nights, "night")} · ${num(context.training.sleep.totalHours)} h total`}
        />
        <Metric
          label="Active energy (last 30 days)"
          value={`${compact(activity.energy)} kcal`}
          hint={`${num(activity.exerciseMinutes)} exercise min · ${plural(activity.days, "summary day")}`}
        />
        {showMoveMinutes ? (
          <Metric
            label="Move minutes (last 30 days)"
            value={compact(activity.moveMinutes)}
            hint="Apple Move minutes from activity summaries"
          />
        ) : null}
      </div>

      <StepsAreaChart data={stepSeries.map((point) => ({ day: point.day, total: point.value }))} />
      <SleepStackChart data={sleepSeries} />
      <ActivityChart data={activitySeries} />
    </div>
  );
}
