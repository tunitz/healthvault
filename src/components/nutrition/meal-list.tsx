"use client";

import { deleteEntryAction, updateEntryAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { num } from "@/lib/format";
import type { FoodEntry, Meal } from "@/lib/services/nutrition";

const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const MEALS: { key: Meal; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

export function MealList({ meals }: { meals: Record<Meal, FoodEntry[]> }) {
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      {MEALS.map(({ key, label }) => {
        const entries = meals[key];
        const kcal = entries.reduce((sum, entry) => sum + entry.kcal, 0);
        return (
          <section key={key} className="min-w-0 rounded-xl border border-border p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium">{label}</h3>
              <span className="num text-xs text-muted-foreground">{num(kcal, 0)} kcal</span>
            </div>

            {entries.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">Nothing logged</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/60">
                {entries.map((entry) => (
                  <li key={entry.id} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="truncate">{entry.name}</span>
                          {entry.estimated ? <Badge variant="outline">estimated</Badge> : null}
                        </p>
                        <p className="num text-xs text-muted-foreground">
                          {num(entry.grams)} g · {num(entry.proteinG, 1)} g protein
                        </p>
                      </div>
                      <p className="num shrink-0 text-sm">{num(entry.kcal, 0)} kcal</p>
                    </div>

                    <details className="mt-1">
                      <summary
                        aria-label={`Edit ${entry.name}`}
                        className="cursor-pointer text-xs text-muted-foreground"
                      >
                        Edit
                      </summary>
                      <ActionForm action={updateEntryAction} className="mt-2 grid gap-2">
                        <input type="hidden" name="id" value={entry.id} />
                        <input type="hidden" name="old-kcal" value={entry.kcal} />
                        <input type="hidden" name="old-proteinG" value={entry.proteinG} />
                        <input type="hidden" name="old-carbsG" value={entry.carbsG} />
                        <input type="hidden" name="old-fatG" value={entry.fatG} />
                        <input type="hidden" name="old-fibreG" value={entry.fibreG} />
                        <input type="hidden" name="old-sodiumMg" value={entry.sodiumMg} />
                        <div className="grid grid-cols-2 gap-2">
                          <Field label="Name">
                            <Input name="name" defaultValue={entry.name} required maxLength={200} />
                          </Field>
                          <Field label="Meal">
                            <select name="meal" defaultValue={entry.meal} className={SELECT}>
                              {MEALS.map((meal) => (
                                <option key={meal.key} value={meal.key}>
                                  {meal.label}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Grams">
                            <Input name="grams" type="number" inputMode="decimal" step="0.1" min="0.1" defaultValue={entry.grams} required />
                          </Field>
                          <Field label="kcal">
                            <Input name="kcal" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={entry.kcal} />
                          </Field>
                          <Field label="Protein (g)">
                            <Input name="proteinG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={entry.proteinG} />
                          </Field>
                          <Field label="Carbs (g)">
                            <Input name="carbsG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={entry.carbsG} />
                          </Field>
                          <Field label="Fat (g)">
                            <Input name="fatG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={entry.fatG} />
                          </Field>
                          <Field label="Fibre (g)">
                            <Input name="fibreG" type="number" inputMode="decimal" step="0.1" min="0" defaultValue={entry.fibreG} />
                          </Field>
                          <Field label="Sodium (mg)">
                            <Input name="sodiumMg" type="number" inputMode="decimal" step="1" min="0" defaultValue={entry.sodiumMg} />
                          </Field>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            name="estimated"
                            defaultChecked={entry.estimated === 1}
                            className="size-4 accent-[var(--primary)]"
                          />
                          Macros are estimated
                        </label>
                        <div className="flex items-center justify-between gap-2">
                          <SubmitButton size="sm">Save</SubmitButton>
                        </div>
                      </ActionForm>
                    </details>

                    <ActionForm
                      action={deleteEntryAction}
                      className="mt-1"
                      confirm={`Delete ${entry.name}? This cannot be undone.`}
                    >
                      <input type="hidden" name="id" value={entry.id} />
                      <SubmitButton variant="ghost" size="xs" aria-label={`Delete ${entry.name}`}>
                        Delete
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
