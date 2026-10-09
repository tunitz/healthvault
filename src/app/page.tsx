import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { ActivityChart } from "@/components/activity-chart";
import { SleepStackChart } from "@/components/sleep-stack-chart";
import { StepsAreaChart } from "@/components/steps-area-chart";
import {
  activitySummarySeries,
  activitySummaryTotals,
  counts,
  dailyTotals,
  sleepByDayStage,
  sleepSummary,
  stepsSummary,
} from "@/db/queries";
import { compact, num, plural } from "@/lib/format";

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

export default function DashboardPage() {
  const totals = counts();
  if (totals.records === 0) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Logo size={40} />
        <h1 className="text-2xl font-semibold tracking-tight">No health data yet</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Export your data on the iPhone: Health app → your picture → Export All Health Data, then
          import the resulting <code>Export.zip</code> on the Import page.
        </p>
        <Button asChild>
          <Link href="/uploads">Go to Import</Link>
        </Button>
      </div>
    );
  }

  const steps = stepsSummary(30);
  const sleep = sleepSummary(30);
  const activity = activitySummaryTotals(30);
  const stepSeries = dailyTotals("HKQuantityTypeIdentifierStepCount", 30);
  const sleepSeries = sleepByDayStage(90);
  const activitySeries = activitySummarySeries(30);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {plural(totals.records, "record", "records", compact(totals.records))} · {plural(totals.workouts, "workout")} ·{" "}
          {plural(totals.summaries, "activity day")} · {plural(totals.uploads, "upload")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
        <Metric
          label="Steps (last 30 days)"
          value={compact(steps.totalInWindow)}
          hint={`${num(steps.avgPerDay)} / day average · ${compact(steps.allTimeSteps)} all time`}
        />
        <Metric
          label="Sleep (last 30 days)"
          value={`${num(sleep.avgPerNight)} h`}
          hint={`${plural(sleep.nights, "night")} · ${num(sleep.totalHours)} h total`}
        />
        <Metric
          label="Active energy (last 30 days)"
          value={`${compact(activity.energy)} kcal`}
          hint={`${num(activity.exerciseMinutes)} exercise min · ${plural(activity.days, "summary day")}`}
        />
        <Metric
          label="Move minutes (last 30 days)"
          value={compact(activity.moveMinutes)}
          hint="Apple Move minutes from activity summaries"
        />
      </div>

      <StepsAreaChart data={stepSeries} />
      <SleepStackChart data={sleepSeries} />
      <ActivityChart data={activitySeries} />
    </div>
  );
}
