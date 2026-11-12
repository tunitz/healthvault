import type { Metadata } from "next";
import Link from "next/link";
import { addDays, dayHeading, isDay, lastDays } from "@/lib/day";
import { getTimezone } from "@/lib/services/profile";
import { currentDay } from "@/lib/services/context";
import {
  dayNutrition,
  nutritionRange,
  recentFoods,
  resolveTargets,
  searchFoods,
  type Targets,
} from "@/lib/services/nutrition";
import { num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  CopyDayForm,
  NewFoodForm,
  QuickAddForm,
  RecentFoods,
  SavedFoodForm,
  TargetsForm,
} from "@/components/nutrition/nutrition-forms";
import { MealList } from "@/components/nutrition/meal-list";
import { NutritionNav } from "@/components/nutrition/nutrition-nav";
import { NutritionTrendChart } from "@/components/nutrition/nutrition-trend-chart";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Nutrition" };

function MacroBar({
  label,
  value,
  target,
  unit,
  color,
}: {
  label: string;
  value: number;
  target: number;
  unit: string;
  color: string;
}) {
  const pct = target > 0 ? (value / target) * 100 : 0;
  const over = value > target;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className={over ? "font-medium text-destructive" : "text-muted-foreground"}>
          {label}
          {over ? " · over" : ""}
        </span>
        <span className="num">
          {num(value, 1)} / {num(target, 0)} {unit}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.max(0, Math.round(pct)))}
        aria-valuetext={`${num(value, 1)} of ${num(target, 0)} ${unit}${over ? " (over target)" : ""}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(100, Math.max(0, pct))}%`,
            background: over ? "var(--destructive)" : color,
          }}
        />
      </div>
    </div>
  );
}

function MacroSummary({ data }: { data: ReturnType<typeof dayNutrition> }) {
  const pct = data.targets.kcal > 0 ? (data.totals.kcal / data.targets.kcal) * 100 : 0;
  const over = pct > 100;
  const ring = Math.min(100, Math.max(0, pct));
  const kcalOver = data.remaining.kcal < 0;

  return (
    <div className="grid gap-6 rounded-xl border border-border p-4 sm:grid-cols-[auto_1fr] sm:items-center">
      <div
        role="img"
        aria-label={`${num(data.totals.kcal, 0)} of ${num(data.targets.kcal, 0)} kcal${
          kcalOver ? `, ${num(Math.abs(data.remaining.kcal), 0)} over` : ""
        }`}
        className="relative mx-auto size-28 shrink-0 rounded-full"
        style={{
          background: `conic-gradient(${over ? "var(--destructive)" : "var(--chart-1)"} ${ring}%, var(--muted) 0)`,
        }}
      >
        <div className="absolute inset-2 grid place-items-center rounded-full bg-card text-center">
          <div>
            <p className="num text-xl font-semibold tracking-tight">{num(Math.abs(data.remaining.kcal), 0)}</p>
            <p className="text-[11px] text-muted-foreground">{kcalOver ? "kcal over" : "kcal left"}</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm">
            <span className="num font-medium">{num(data.totals.kcal, 0)}</span>
            <span className="text-muted-foreground"> / {num(data.targets.kcal, 0)} kcal</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {data.targets.source === "suggested" ? "Suggested targets" : `Manual targets from ${data.targets.effectiveFrom}`}
          </p>
        </div>
        <MacroBar label="Protein" value={data.totals.proteinG} target={data.targets.proteinG} unit="g" color="var(--chart-1)" />
        <MacroBar label="Carbs" value={data.totals.carbsG} target={data.targets.carbsG} unit="g" color="var(--chart-2)" />
        <MacroBar label="Fat" value={data.totals.fatG} target={data.targets.fatG} unit="g" color="var(--chart-4)" />
        {data.estimatedEntries > 0 ? (
          <p className="text-xs text-muted-foreground">
            {data.estimatedEntries} {data.estimatedEntries === 1 ? "entry is" : "entries are"} estimated.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default async function NutritionPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const timezone = getTimezone();
  const today = currentDay();
  const day = typeof params.day === "string" && isDay(params.day) ? params.day : today;
  const range = params.range === "30" ? 30 : 7;

  const data = dayNutrition(day);
  const foods = searchFoods("", 100);
  const recent = recentFoods(12);
  const previousDay = addDays(day, -1);

  const rangeRows = new Map(nutritionRange(range, day).map((row) => [row.day, row]));
  const trend = lastDays(range, day).map((value) => {
    const row = rangeRows.get(value);
    return row ?? { day: value, kcal: 0, targetKcal: resolveTargets(value).kcal };
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Nutrition</h1>
        <p className="text-sm text-muted-foreground">
          {dayHeading(day)} · {timezone}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="icon-sm" className="max-sm:size-11" aria-label="Previous day">
            <Link href={`/nutrition?day=${addDays(day, -1)}&range=${range}`}>
              <ChevronLeft aria-hidden />
            </Link>
          </Button>
          <form method="get" className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
            <Input type="date" name="day" defaultValue={day} aria-label="Day" className="min-w-0 flex-1 sm:w-40 sm:flex-none" />
            <input type="hidden" name="range" value={range} />
            <Button type="submit" variant="outline" size="sm">
              Go
            </Button>
          </form>
          <Button asChild variant="outline" size="icon-sm" className="max-sm:size-11" aria-label="Next day">
            <Link href={`/nutrition?day=${addDays(day, 1)}&range=${range}`}>
              <ChevronRight aria-hidden />
            </Link>
          </Button>
          {day !== today ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/nutrition?day=${today}&range=${range}`}>Today</Link>
            </Button>
          ) : null}
        </div>
        <div className="w-full sm:ms-auto sm:w-auto">
          <CopyDayForm day={day} previousDay={previousDay} />
        </div>
      </div>

      <NutritionNav />

      <MacroSummary data={data} />

      <div className="grid gap-3 lg:grid-cols-2">
        <QuickAddForm day={day} />
        <SavedFoodForm day={day} foods={foods} />
        <NewFoodForm />
        <TargetsForm day={day} targets={data.targets as Targets} />
      </div>

      <RecentFoods recent={recent} />

      <MealList meals={data.meals} timezone={data.timezone} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-medium">Trend</h2>
            <p className="text-xs text-muted-foreground">Eaten against that day&apos;s target.</p>
          </div>
          <div className="flex gap-1">
            <Button asChild variant={range === 7 ? "secondary" : "ghost"} size="xs">
              <Link href={`/nutrition?day=${day}&range=7`} aria-current={range === 7 ? "true" : undefined}>
                7 days
              </Link>
            </Button>
            <Button asChild variant={range === 30 ? "secondary" : "ghost"} size="xs">
              <Link href={`/nutrition?day=${day}&range=30`} aria-current={range === 30 ? "true" : undefined}>
                30 days
              </Link>
            </Button>
          </div>
        </div>
        <NutritionTrendChart data={trend} />
      </section>
    </div>
  );
}
