import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { addDays, dayHeading, formatClockSeconds, isDay, lastDays, localTimeMs } from "@/lib/day";
import { sqlite } from "@/db";
import { requireSession } from "@/lib/auth";
import { getTimezone } from "@/lib/services/profile";
import { currentDay } from "@/lib/services/context";
import {
  createTargetResolver,
  dayNutrition,
  nutritionRange,
  logMeal,
  logRecipe,
  previewEntry,
  recentFoods,
  searchFoods,
  type Targets,
} from "@/lib/services/nutrition";
import { getRecipe, listRecipes } from "@/lib/services/recipes";
import { num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  toLoggingFoodOption,
  type EntryPreviewResult,
  type FoodSearchResult,
  type LoggingFoodOption,
  type LoggingRecipeOption,
  type RecentFoodOption,
  type SaveDraftResult,
} from "@/lib/foods-ui";
import { CopyDayForm, Diary, NewFoodForm, TargetsForm } from "@/components/nutrition/nutrition-forms";
import { NutritionNav } from "@/components/nutrition/nutrition-nav";
import { NutritionTrendChart } from "@/components/nutrition/nutrition-trend-chart";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Nutrition" };

/** Sensible meal default from the local clock, never a hard-coded breakfast. */
function defaultMeal(tz: string): "breakfast" | "lunch" | "dinner" | "snack" {
  const hour = Number(formatClockSeconds(Date.now(), tz).slice(0, 2));
  if (hour < 11) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}

/**
 * Server actions for the Add-food draft. They run through the same service layer the agent uses,
 * so the UI never re-implements nutrition arithmetic or the provenance rules. Each one re-checks
 * the session because a server action is a reachable endpoint in its own right.
 */
async function searchFoodsAction(query: string): Promise<FoodSearchResult> {
  "use server";
  await requireSession();
  try {
    // A bounded page of matches from the WHOLE library, searched server-side — never a capped
    // slice of foods preloaded into the browser.
    return { ok: true, items: searchFoods(query, 50).map(toLoggingFoodOption) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Food search failed" };
  }
}

async function previewEntryAction(entry: Record<string, unknown>): Promise<EntryPreviewResult> {
  "use server";
  await requireSession();
  try {
    const result = previewEntry(entry);
    return {
      ok: true,
      preview: {
        name: result.name,
        grams: result.grams,
        foodId: result.foodId,
        weightSource: result.weightSource,
        macroSource: result.macroSource,
        gramsAs: result.gramsAs,
        rawEquivalentGrams: result.rawEquivalentGrams,
        basisState: result.basisState,
        basisYieldFactor: result.basisYieldFactor,
        kcal: result.macros.kcal,
        proteinG: result.macros.proteinG,
        carbsG: result.macros.carbsG,
        fatG: result.macros.fatG,
        fibreG: result.macros.fibreG,
        sodiumMg: result.macros.sodiumMg,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not preview entry" };
  }
}

/** Read-only preview of a saved recipe portion, using the recipe service's per-serving math. */
async function previewRecipeAction(input: {
  recipeId: number;
  servingFraction: string;
}): Promise<EntryPreviewResult> {
  "use server";
  await requireSession();
  try {
    const recipe = getRecipe(input.recipeId);
    if (!recipe.complete) {
      return { ok: false, error: "This recipe has ingredients with unknown nutrition" };
    }
    const fraction = Number(input.servingFraction);
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 100) {
      return { ok: false, error: "Portion must be between 0.01 and 100" };
    }
    const macros = recipe.perServing.macros;
    const grams = recipe.perServing.grams * fraction;
    return {
      ok: true,
      preview: {
        name: recipe.name,
        grams,
        foodId: null,
        weightSource: "counted",
        macroSource: "recipe",
        gramsAs: "",
        rawEquivalentGrams: grams,
        basisState: "",
        basisYieldFactor: 1,
        kcal: macros.kcal * fraction,
        proteinG: macros.proteinG * fraction,
        carbsG: macros.carbsG * fraction,
        fatG: macros.fatG * fraction,
        fibreG: macros.fibreG * fraction,
        sodiumMg: macros.sodiumMg * fraction,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not preview recipe" };
  }
}

type DraftSaveInput = {
  day: string;
  meal: string;
  time: string;
  entries: (Record<string, unknown> & { key?: string })[];
  recipes: { recipeId: number; servingFraction: string }[];
};

async function saveMealDraftAction(input: DraftSaveInput): Promise<SaveDraftResult> {
  "use server";
  await requireSession();
  try {
    if (input.entries.length === 0 && input.recipes.length === 0) {
      return { ok: false, error: "Add at least one item before saving" };
    }
    if (!isDay(input.day)) {
      return { ok: false, error: "Choose a valid date" };
    }
    let eatenAt: number | undefined;
    if (input.time) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
        return { ok: false, error: "Eaten time must be HH:MM" };
      }
      eatenAt = localTimeMs(input.day, input.time, getTimezone());
    }

    // Validate each line through the read-only service path first so a bad portion is reported
    // against the exact draft item that caused it, not as an anonymous array index.
    for (const entry of input.entries) {
      try {
        previewEntry(entry);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Invalid entry",
          ...(entry.key ? { itemKey: entry.key } : {}),
        };
      }
    }

    sqlite.transaction(() => {
      if (input.entries.length > 0) {
        logMeal({
          day: input.day,
          meal: input.meal,
          ...(eatenAt === undefined ? {} : { eatenAt }),
          entries: input.entries,
        });
      }
      for (const recipe of input.recipes) {
        logRecipe({
          recipeId: recipe.recipeId,
          day: input.day,
          meal: input.meal,
          servingFraction: recipe.servingFraction || "1",
          ...(eatenAt === undefined ? {} : { eatenAt }),
        });
      }
    })();

    revalidatePath("/nutrition");
    revalidatePath("/");
    const count = input.entries.length + input.recipes.length;
    return { ok: true, count, message: count === 1 ? "Logged 1 item" : `Logged ${count} items` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save meal" };
  }
}

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
        <div className="grid gap-3 pt-1 sm:grid-cols-2">
          <MacroBar label="Fibre" value={data.totals.fibreG} target={data.targets.fibreG} unit="g" color="var(--chart-3)" />
          <MacroBar label="Sodium" value={data.totals.sodiumMg} target={data.targets.sodiumMg} unit="mg" color="var(--chart-5)" />
        </div>
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
  // A bounded suggestion list; the Add-food picker searches the whole library on demand.
  const initialFoods: LoggingFoodOption[] = searchFoods("", 50).map(toLoggingFoodOption);
  const foodById = new Map(initialFoods.map((food) => [food.id, food]));
  const recent: RecentFoodOption[] = recentFoods(12).map((row) => ({
    ...row,
    ...(row.foodId !== null && foodById.has(row.foodId) ? { food: foodById.get(row.foodId)! } : {}),
  }));
  const recipeOptions: LoggingRecipeOption[] = listRecipes({ limit: 50 }).items
    .filter((recipe) => !recipe.archived)
    .map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      servingsTotal: recipe.servingsTotal,
      complete: recipe.complete,
      unresolvedCount: recipe.unresolvedCount,
    }));
  const previousDay = addDays(day, -1);

  const rangeRows = new Map(nutritionRange(range, day).map((row) => [row.day, row]));
  const resolveTarget = createTargetResolver();
  const trend = lastDays(range, day).map((value) => {
    const row = rangeRows.get(value);
    return row ?? { day: value, kcal: 0, targetKcal: resolveTarget(value).kcal };
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

      {/* The diary is the primary surface. The unified Add-food entry point and the meal list
          live together so logging starts from what was eaten, not from a stack of forms. */}
      <Diary
        day={day}
        defaultMeal={defaultMeal(timezone)}
        timezone={data.timezone}
        meals={data.meals}
        recent={recent}
        recipes={recipeOptions}
        initialFoods={initialFoods}
        searchFoods={searchFoodsAction}
        previewEntry={previewEntryAction}
        previewRecipe={previewRecipeAction}
        saveDraft={saveMealDraftAction}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <NewFoodForm />
        <TargetsForm day={day} targets={data.targets as Targets} />
      </div>

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
