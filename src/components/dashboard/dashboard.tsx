import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WheyLogButtons } from "@/components/supplements/whey-forms";
import { hasWheyAction } from "@/lib/services/whey";
import { compact, instant, num, plural } from "@/lib/format";
import { dayHeading } from "@/lib/day";
import { formatWeight, formatWeightDelta, resolveUnits } from "@/lib/units";
import type { HealthContext } from "@/lib/services/context";
import type { WidgetPreference } from "@/lib/services/settings";
import { cn } from "@/lib/utils";
import { orderedVisibleWidgets, SIZE_SPAN } from "./registry";
import { supplementHint } from "./data";
import type { DashboardData } from "./widget-data";
import { WidgetView } from "./widget-view";
import { WidgetMenu } from "./widget-menu";

function TodayCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num truncate text-xl font-semibold tracking-tight">{value}</p>
      <p className="truncate text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** The configured dashboard. Content is identical on every device; only grid spans differ by width. */
export function Dashboard({
  context,
  data,
  widgets,
}: {
  context: HealthContext;
  data: DashboardData;
  widgets: Record<string, WidgetPreference>;
}) {
  const ordered = orderedVisibleWidgets(widgets);
  const totals = context.data.counts;
  const canUndoWhey = hasWheyAction(context.today);
  const last = data.lastSuccess;
  const units = resolveUnits(context.profile.units);
  const sample = data.byRange["30d"] ?? Object.values(data.byRange)[0];
  const lastStep = sample?.steps.at(-1);
  const stepsToday = lastStep?.day === context.today ? lastStep.value : null;
  const lastNight = sample?.sleepDuration.at(-1);
  const next = context.nextSupplement;
  const supplementLabel = supplementHint(
    context.supplements,
    next ? `${next.supplement.name}${next.schedule.time ? ` at ${next.schedule.time}` : ""}` : null,
  );
  const { remaining, totals: nutritionTotals, targets } = context.nutrition;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {plural(totals.records, "record", "records", compact(totals.records))} ·{" "}
            {plural(totals.workouts, "workout")} · {plural(totals.summaries, "activity day")} ·{" "}
            {plural(totals.uploads, "upload")}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/dashboard">Customize</Link>
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Today</h2>
          <p className="text-xs text-muted-foreground">{dayHeading(context.today)}</p>
        </div>
        {!context.profile.started ? (
          <Link href="/profile" className="text-sm text-primary underline underline-offset-4">
            Complete your profile
          </Link>
        ) : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <TodayCard
            label="Calories"
            value={remaining.kcal < 0 ? `${num(Math.abs(remaining.kcal), 0)} over` : `${num(remaining.kcal, 0)} left`}
            hint={`${num(nutritionTotals.kcal, 0)} / ${num(targets.kcal, 0)} kcal`}
          />
          <TodayCard
            label="Weight"
            value={formatWeight(context.weight.latest?.value, units)}
            hint={context.weight.change7dKg !== null ? `${formatWeightDelta(context.weight.change7dKg, units)} / 7d` : "not logged"}
          />
          <TodayCard
            label="Supplements"
            value={`${context.supplements.taken} / ${context.supplements.total}`}
            hint={supplementLabel}
          />
          <TodayCard
            label="Movement"
            value={stepsToday === null ? "—" : `${compact(stepsToday)} steps`}
            hint={lastNight ? `${num(lastNight.value, 1)} h sleep` : "No recent sleep"}
          />
        </div>
        {context.profile.wheyLink || canUndoWhey ? (
          <WheyLogButtons configured={context.profile.wheyLink !== null} canUndo={canUndoWhey} />
        ) : null}
        <p className="text-xs text-muted-foreground">
          {last
            ? `Last successful import ${instant(last.finishedAtMs, context.timezone)} · ${plural(last.inserted, "new row")}`
            : "No completed import yet"}
          {context.data.lastRecordDay || context.data.lastWorkoutDay
            ? ` · Apple data through ${context.data.lastRecordDay ?? "—"} · workouts through ${context.data.lastWorkoutDay ?? "—"}`
            : ""}
        </p>
      </div>

      {ordered.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No widgets are visible. <Link href="/settings/dashboard" className="text-primary underline underline-offset-4">Choose cards</Link>.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {ordered.map(({ id, pref }, index) => (
            <section
              key={id}
              aria-label={`${id} widget, position ${index + 1} of ${ordered.length}`}
              className={cn(
                "flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm",
                SIZE_SPAN[pref.size],
              )}
            >
              <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-2">
                <h2 className="text-sm font-medium capitalize">{id}</h2>
                <WidgetMenu
                  id={id}
                  index={index}
                  total={ordered.length}
                  range={pref.range}
                  display={pref.display}
                />
              </header>
              <div className="min-w-0 flex-1">
                <WidgetView id={id} pref={pref} context={context} data={data} />
              </div>
            </section>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Layout and card views are saved per account. Change them under Settings → Dashboard.
      </p>
    </div>
  );
}
