import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { compact, num } from "@/lib/format";

export const dynamic = "force-dynamic";

function StatCard({ title, value, hint, accent, valueClass }: {
  title: string; value: string; hint?: string; accent: string; valueClass?: string;
}) {
  return (
    <Card className={`overflow-hidden border-l-4 ${accent} bg-card/60`}>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className={`text-3xl tabular-nums ${valueClass ?? ""}`}>{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

export default function DashboardPage() {
  const totals = counts();
  if (totals.records === 0) {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">No health data yet</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Export your data on the iPhone: Health app → your picture → Export All Health Data, then
          upload the resulting <code>Export.zip</code> here.
        </p>
        <Button asChild>
          <Link href="/uploads">Go to upload</Link>
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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {compact(totals.records)} records · {num(totals.workouts)} workouts · {num(totals.summaries)} activity
          days · {num(totals.uploads)} uploads
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          accent="border-l-emerald-500"
          valueClass="text-emerald-400"
          title="Steps (last 30 days)"
          value={compact(steps.totalInWindow)}
          hint={`${num(steps.avgPerDay)} / day average · ${compact(steps.allTimeSteps)} all time`}
        />
        <StatCard
          accent="border-l-violet-500"
          valueClass="text-violet-400"
          title="Sleep (last 30 days)"
          value={`${num(sleep.avgPerNight)} h`}
          hint={`${num(sleep.nights)} nights · ${num(sleep.totalHours)} h total`}
        />
        <StatCard
          accent="border-l-amber-500"
          valueClass="text-amber-400"
          title="Active energy (last 30 days)"
          value={`${compact(activity.energy)} kcal`}
          hint={`${num(activity.exerciseMinutes)} exercise min · ${num(activity.days)} summary days`}
        />
        <StatCard
          accent="border-l-sky-500"
          valueClass="text-sky-400"
          title="Move minutes (last 30 days)"
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
