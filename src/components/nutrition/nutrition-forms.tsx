"use client";

import { useMemo, useState } from "react";
import {
  addFoodAction,
  copyDayAction,
  logFoodAction,
  logQuickMealAction,
  setTargetsAction,
} from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { num } from "@/lib/format";
import type { Food, Targets } from "@/lib/services/nutrition";

const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const MEALS = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
];

function MealSelect({ defaultValue = "breakfast" }: { defaultValue?: string }) {
  return (
    <select name="meal" defaultValue={defaultValue} className={SELECT}>
      {MEALS.map((meal) => (
        <option key={meal.value} value={meal.value}>
          {meal.label}
        </option>
      ))}
    </select>
  );
}

export function QuickAddForm({ day }: { day: string }) {
  return (
    <details className="rounded-xl border border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Quick add</summary>
      <ActionForm action={logQuickMealAction} resetOnSuccess className="grid gap-3 border-t border-border p-4">
        <input type="hidden" name="day" value={day} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Meal">
            <MealSelect />
          </Field>
          <Field label="Grams">
            <Input name="grams" type="number" inputMode="decimal" step="0.1" min="0.1" defaultValue="100" required />
          </Field>
        </div>
        <Field label="Food">
          <Input name="name" required maxLength={200} placeholder="e.g. chicken breast" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="kcal">
            <Input name="kcal" type="number" inputMode="decimal" step="0.1" min="0" required />
          </Field>
          <Field label="Protein (g)">
            <Input name="proteinG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
          </Field>
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">More macros</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="Carbs (g)">
              <Input name="carbsG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
            </Field>
            <Field label="Fat (g)">
              <Input name="fatG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
            </Field>
            <Field label="Fibre (g)">
              <Input name="fibreG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
            </Field>
            <Field label="Sodium (mg)">
              <Input name="sodiumMg" type="number" inputMode="decimal" step="1" min="0" defaultValue="0" />
            </Field>
          </div>
        </details>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" name="estimated" defaultChecked className="size-4 accent-[var(--primary)]" />
          Macros are estimated
        </label>
        <div className="flex justify-end">
          <SubmitButton size="sm">Add entry</SubmitButton>
        </div>
      </ActionForm>
    </details>
  );
}

export function SavedFoodForm({ day, foods }: { day: string; foods: Food[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? foods.filter(
          (food) =>
            food.name.toLowerCase().includes(needle) ||
            (food.brand ?? "").toLowerCase().includes(needle),
        )
      : foods;
    return matches.slice(0, 40);
  }, [foods, query]);

  if (foods.length === 0) {
    return (
      <div className="rounded-xl border border-border p-4">
        <p className="text-sm font-medium">Saved foods</p>
        <p className="mt-1 text-xs text-muted-foreground">No saved foods yet. Add one below or let the agent create it.</p>
      </div>
    );
  }

  return (
    <details className="rounded-xl border border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Log a saved food</summary>
      <ActionForm action={logFoodAction} className="grid gap-3 border-t border-border p-4">
        <input type="hidden" name="day" value={day} />
        <Field label="Search saved foods">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name or brand"
          />
        </Field>
        <Field label="Food">
          <select name="foodId" className={SELECT} required>
            {filtered.map((food) => (
              <option key={food.id} value={food.id}>
                {food.name}
                {food.brand ? ` (${food.brand})` : ""} — {num(food.kcalPer100g, 0)} kcal/100g
              </option>
            ))}
          </select>
        </Field>
        {filtered.length === 0 ? <p className="text-xs text-muted-foreground">No saved food matches that search.</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Meal">
            <MealSelect />
          </Field>
          <Field label="Grams">
            <Input name="grams" type="number" inputMode="decimal" step="0.1" min="0.1" defaultValue="100" required />
          </Field>
        </div>
        <div className="flex justify-end">
          <SubmitButton size="sm">Log food</SubmitButton>
        </div>
      </ActionForm>
    </details>
  );
}

export function RecentFoods({
  recent,
}: {
  recent: { name: string; foodId: number | null; grams: number; kcal: number }[];
}) {
  if (recent.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Recent</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {recent.map((food) => (
          <li
            key={`${food.name}-${food.foodId ?? "raw"}`}
            className="flex min-w-0 items-baseline gap-1"
          >
            <span className="truncate text-foreground">{food.name}</span>
            <span className="num shrink-0 text-muted-foreground">
              {num(food.grams, 0)} g · {num(food.kcal, 0)} kcal
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NewFoodForm() {
  return (
    <details className="rounded-xl border border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">New food</summary>
      <ActionForm action={addFoodAction} resetOnSuccess className="grid gap-3 border-t border-border p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input name="name" required maxLength={200} />
          </Field>
          <Field label="Brand">
            <Input name="brand" maxLength={200} placeholder="Optional" />
          </Field>
        </div>
        <Field label="Serving (g)" hint="Used as the default portion">
          <Input name="servingGrams" type="number" inputMode="decimal" step="1" min="1" defaultValue="100" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="kcal / 100g">
            <Input name="kcal" type="number" inputMode="decimal" step="0.1" min="0" required />
          </Field>
          <Field label="Protein / 100g">
            <Input name="proteinG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
          </Field>
          <Field label="Carbs / 100g">
            <Input name="carbsG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
          </Field>
          <Field label="Fat / 100g">
            <Input name="fatG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
          </Field>
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">More per 100g</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="Fibre (g)">
              <Input name="fibreG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue="0" />
            </Field>
            <Field label="Sodium (mg)">
              <Input name="sodiumMg" type="number" inputMode="decimal" step="1" min="0" defaultValue="0" />
            </Field>
          </div>
        </details>
        <div className="flex justify-end">
          <SubmitButton size="sm">Save food</SubmitButton>
        </div>
      </ActionForm>
    </details>
  );
}

export function TargetsForm({ day, targets }: { day: string; targets: Targets }) {
  return (
    <details className="rounded-xl border border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        Targets <span className="ml-1 text-xs font-normal text-muted-foreground">{targets.source}</span>
      </summary>
      <ActionForm action={setTargetsAction} className="grid gap-3 border-t border-border p-4">
        <input type="hidden" name="effectiveFrom" value={day} />
        <p className="text-xs text-muted-foreground">
          {targets.source === "suggested"
            ? "Calculated from profile and latest weight. Saving makes them manual from this day."
            : `Manual targets effective from ${targets.effectiveFrom}.`}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="kcal">
            <Input name="kcal" type="number" inputMode="decimal" step="1" min="0" defaultValue={Math.round(targets.kcal)} required />
          </Field>
          <Field label="Protein (g)">
            <Input name="proteinG" type="number" inputMode="decimal" step="1" min="0" defaultValue={Math.round(targets.proteinG)} />
          </Field>
          <Field label="Carbs (g)">
            <Input name="carbsG" type="number" inputMode="decimal" step="1" min="0" defaultValue={Math.round(targets.carbsG)} />
          </Field>
          <Field label="Fat (g)">
            <Input name="fatG" type="number" inputMode="decimal" step="1" min="0" defaultValue={Math.round(targets.fatG)} />
          </Field>
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">More targets</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="Fibre (g)">
              <Input name="fibreG" type="number" inputMode="decimal" step="1" min="0" defaultValue={Math.round(targets.fibreG)} />
            </Field>
            <Field label="Sodium (mg)">
              <Input name="sodiumMg" type="number" inputMode="decimal" step="1" min="0" defaultValue={Math.round(targets.sodiumMg)} />
            </Field>
          </div>
        </details>
        <div className="flex justify-end">
          <SubmitButton size="sm">Save targets</SubmitButton>
        </div>
      </ActionForm>
    </details>
  );
}

export function CopyDayForm({ day, previousDay }: { day: string; previousDay: string }) {
  return (
    <ActionForm
      action={copyDayAction}
      className="flex w-full flex-col items-stretch gap-1 sm:inline-flex sm:w-auto sm:items-end"
    >
      <input type="hidden" name="fromDay" value={previousDay} />
      <input type="hidden" name="toDay" value={day} />
      <SubmitButton variant="outline" size="sm" className="w-full sm:w-auto">
        Copy {previousDay.slice(5)}
      </SubmitButton>
    </ActionForm>
  );
}
