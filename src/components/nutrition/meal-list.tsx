"use client";

import Link from "next/link";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { ChevronDown, History } from "lucide-react";
import { deleteEntryAction, entryRevisionsAction, updateEntryAction, updateLegacyEntryAction, updatePortionAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { instant, num, plural } from "@/lib/format";
import {
  amountBasisLabel,
  basisLabel,
  parseStoredMeasure,
  parseStoredServing,
  revisionReasonLabel,
  weighedBasisLabel,
} from "@/lib/meal-review";
import type { EntryRevisionSummary, LoggedIngredientEntry } from "@/lib/services/food-log-snapshots";
import type { Meal } from "@/lib/services/nutrition";

const SELECT =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-8 md:text-sm dark:bg-input/30";

const MEALS: { key: Meal; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

/** A small inline tag with an explicit label; never a bare colour. */
function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <Badge variant="outline" title={title}>
      {children}
    </Badge>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Ingredient snapshot rows
 * ------------------------------------------------------------------------------------------- */

function IngredientRows({ entry }: { entry: LoggedIngredientEntry }) {
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {entry.ingredients.map((ingredient) => {
        const measure = parseStoredMeasure(ingredient.measureJson);
        const weighed = weighedBasisLabel(ingredient.gramsAs, ingredient.foodState);
        const basis = amountBasisLabel(ingredient.amountBasis);
        const storedBasis = basisLabel(ingredient.foodState);
        return (
          <li key={ingredient.id} className="flex flex-col gap-1 py-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                  <span className="min-w-0 truncate" title={ingredient.name}>
                    {ingredient.name}
                  </span>
                  {ingredient.resolved === 0 ? (
                    <Tag title="No saved food was linked, so this ingredient has no nutrition values.">
                      nutrition unknown
                    </Tag>
                  ) : null}
                  {ingredient.macroSource === "estimated" ? <Tag>estimated</Tag> : null}
                  {ingredient.weightSource === "guessed" ? <Tag>weight guessed</Tag> : null}
                </p>
                <p className="num text-xs text-muted-foreground">
                  {num(ingredient.grams)} g
                  {measure ? ` · ${num(measure.count)} × ${measure.name}` : ""}
                  {basis ? ` · ${basis}` : ""}
                  {weighed ? ` · ${weighed}` : ""}
                  {storedBasis ? ` · ${storedBasis} basis` : ""}
                </p>
                {ingredient.source ? (
                  <p className="text-[11px] text-muted-foreground">
                    source: {ingredient.source}
                    {ingredient.sourceDate ? ` · ${ingredient.sourceDate}` : ""}
                  </p>
                ) : null}
                {ingredient.foodId !== null ? (
                  <Link
                    href={`/nutrition/corrections?foodId=${ingredient.foodId}`}
                    className="mt-0.5 inline-flex min-h-11 items-center text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground sm:min-h-0"
                  >
                    Correct past meals from this food
                  </Link>
                ) : null}
              </div>
              <p className="num shrink-0 text-xs text-muted-foreground sm:max-w-[14rem] sm:text-right">
                {ingredient.resolved === 0
                  ? "Nutrition unknown"
                  : `${num(ingredient.kcal, 0)} kcal · ${num(ingredient.proteinG, 1)} g protein`}
              </p>
            </div>
            {ingredient.resolved !== 0 ? (
              <p className="num text-[11px] text-muted-foreground">
                {num(ingredient.carbsG, 1)} g carbs · {num(ingredient.fatG, 1)} g fat ·{" "}
                {num(ingredient.fibreG, 1)} g fibre · {num(ingredient.sodiumMg, 0)} mg sodium
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Recipe entries expand to their recorded ingredients.
 *
 * A legacy row (`ingredientSnapshotComplete === false`) says exactly that: the breakdown was never
 * fully recorded, so it is labelled incomplete and any surviving rows are shown as partial — never
 * reconstructed from today's recipe and never padded with zeros. A plain food entry (`null`) has
 * no expander at all.
 */
function SnapshotSection({ entry }: { entry: LoggedIngredientEntry }) {
  const [open, setOpen] = useState(false);
  if (entry.ingredientSnapshotComplete === null) return null;

  const count = entry.ingredients.length;

  return (
    <div className="mt-2">
      {entry.ingredientSnapshotComplete === false ? (
        <>
          <p
            role="note"
            className="rounded-lg border border-warning/40 bg-warning/15 px-2.5 py-1.5 text-xs"
          >
            <span className="font-medium">
              {count === 0
                ? "Ingredients not recorded for this older entry."
                : "This entry's ingredient snapshot is incomplete."}
            </span>{" "}
            <span className="text-muted-foreground">
              {count === 0
                ? "Its totals are what was logged; the breakdown cannot be rebuilt from the recipe."
                : `Only ${count} recorded ${count === 1 ? "ingredient row survives" : "ingredient rows survive"}; missing ingredients are never guessed or shown as zero.`}
            </span>
          </p>
          {count > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer py-3.5 text-xs text-muted-foreground sm:py-0">
                {count} recorded ingredient {count === 1 ? "row" : "rows"} (incomplete)
              </summary>
              <IngredientRows entry={entry} />
            </details>
          ) : null}
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            className="h-11 px-2 text-xs sm:h-8"
          >
            <ChevronDown aria-hidden className={open ? "rotate-180 transition-transform" : "transition-transform"} />
            {open ? "Hide ingredients" : `Ingredients (${count})`}
          </Button>
          {open ? <IngredientRows entry={entry} /> : null}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Portion form (recipe entries only)
 * ------------------------------------------------------------------------------------------- */

function PortionForm({ entry }: { entry: LoggedIngredientEntry }) {
  const stored = parseStoredServing(entry.recipeServingJson);
  const fraction = entry.servingFraction && entry.servingFraction > 0 ? entry.servingFraction : 1;

  if (stored === null) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        This entry has no stored per-serving values, so its portion cannot be rescaled without
        inventing the arithmetic. Log the serving again from the recipe, or edit the entry totals
        explicitly.
      </p>
    );
  }

  return (
    <ActionForm action={updatePortionAction} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="id" value={entry.id} />
      <div className="grid grid-cols-2 items-end gap-2">
        <Field label="Portion" hint={`1 = one serving · ${num(stored.grams)} g and ${num(stored.kcal, 0)} kcal each`}>
          <Input
            name="servingFraction"
            type="number"
            inputMode="decimal"
            min="0.01"
            max="100"
            step="0.01"
            defaultValue={fraction}
            required
            className="max-sm:h-11"
          />
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
        {entry.recipeId !== null ? (
          <Field label="Serving #" hint="Labels which serving of the recipe this is">
            <Input
              name="servingNo"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              defaultValue={entry.servingNo ?? undefined}
              className="max-sm:h-11"
            />
          </Field>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Ingredient amounts and macros are recalculated from the serving this entry stored. The
        recipe itself is not changed.
      </p>

      {/* Macros on a complete snapshot are derived from its ingredients, so they are shown but
          disabled: an aggregate edit could not keep the ingredient rows in step. */}
      <fieldset disabled className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-describedby={`fixed-macros-${entry.id}`}>
        <Field label="kcal">
          <Input defaultValue={num(entry.kcal, 0)} className="num" />
        </Field>
        <Field label="Protein (g)">
          <Input defaultValue={num(entry.proteinG, 1)} className="num" />
        </Field>
        <Field label="Carbs (g)">
          <Input defaultValue={num(entry.carbsG, 1)} className="num" />
        </Field>
        <Field label="Fat (g)">
          <Input defaultValue={num(entry.fatG, 1)} className="num" />
        </Field>
        <Field label="Fibre (g)">
          <Input defaultValue={num(entry.fibreG, 1)} className="num" />
        </Field>
        <Field label="Sodium (mg)">
          <Input defaultValue={num(entry.sodiumMg, 0)} className="num" />
        </Field>
      </fieldset>
      <p id={`fixed-macros-${entry.id}`} className="text-xs text-muted-foreground">
        Edit the portion instead — macros come from the ingredients.
      </p>

      <div className="flex items-center justify-end">
        <SubmitButton size="sm" pendingLabel="Saving…">
          Save portion
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Audit trail
 * ------------------------------------------------------------------------------------------- */

function Revisions({ entry, timezone }: { entry: LoggedIngredientEntry; timezone: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EntryRevisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  if (entry.revisions.length === 0) return null;

  // The card only needs the count. Expanding reads the audit rows through the same
  // `listEntryRevisions` service the agent uses, so reasons and timestamps cannot drift.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || rows !== null || loading) return;
    setError(null);
    startLoading(async () => {
      try {
        const result = await entryRevisionsAction(entry.id);
        if (result.ok) setRows(result.revisions);
        else setError(result.error);
      } catch {
        setError("Could not read the correction history");
      }
    });
  }

  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={toggle}
        aria-expanded={open}
        className="h-11 px-2 text-xs sm:h-8"
      >
        <History aria-hidden />
        Corrected {plural(entry.revisions.length, "time")}
      </Button>
      {open ? (
        <div className="mt-1 rounded-lg border border-border p-2 text-xs">
          {loading ? (
            <p role="status" className="text-muted-foreground">
              Reading history…
            </p>
          ) : error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : rows !== null && rows.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {rows.map((revision) => (
                <li key={revision.id} className="flex flex-col gap-0.5">
                  <span>{revisionReasonLabel(revision.reason)}</span>
                  <span className="text-muted-foreground">
                    {instant(revision.at, timezone)}
                    {revision.ingredient ? " · one ingredient row" : " · entry totals"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No recorded corrections.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Plain food edit (unchanged behaviour)
 * ------------------------------------------------------------------------------------------- */

function PlainFoodEdit({
  entry,
  action = updateEntryAction,
}: {
  entry: LoggedIngredientEntry;
  action?: typeof updateEntryAction;
}) {
  return (
    <ActionForm action={action} className="mt-2 grid gap-2">
      <input type="hidden" name="id" value={entry.id} />
      <input type="hidden" name="old-kcal" value={entry.kcal} />
      <input type="hidden" name="old-proteinG" value={entry.proteinG} />
      <input type="hidden" name="old-carbsG" value={entry.carbsG} />
      <input type="hidden" name="old-fatG" value={entry.fatG} />
      <input type="hidden" name="old-fibreG" value={entry.fibreG} />
      <input type="hidden" name="old-sodiumMg" value={entry.sodiumMg} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">
          <Input name="name" defaultValue={entry.name} required maxLength={200} className="max-sm:h-11" />
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
          <Input
            name="grams"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0.1"
            defaultValue={entry.grams}
            required
            className="max-sm:h-11"
          />
        </Field>
        <Field label="kcal">
          <Input
            name="kcal"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            defaultValue={entry.kcal}
            className="max-sm:h-11"
          />
        </Field>
        <Field label="Protein (g)">
          <Input
            name="proteinG"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            defaultValue={entry.proteinG}
            className="max-sm:h-11"
          />
        </Field>
        <Field label="Carbs (g)">
          <Input
            name="carbsG"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            defaultValue={entry.carbsG}
            className="max-sm:h-11"
          />
        </Field>
        <Field label="Fat (g)">
          <Input
            name="fatG"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            defaultValue={entry.fatG}
            className="max-sm:h-11"
          />
        </Field>
        <Field label="Fibre (g)">
          <Input
            name="fibreG"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            defaultValue={entry.fibreG}
            className="max-sm:h-11"
          />
        </Field>
        <Field label="Sodium (mg)">
          <Input
            name="sodiumMg"
            type="number"
            inputMode="decimal"
            step="1"
            min="0"
            defaultValue={entry.sodiumMg}
            className="max-sm:h-11"
          />
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
        <input
          type="checkbox"
          name="estimated"
          defaultChecked={entry.estimated === 1}
          className="size-4 accent-[var(--primary)]"
        />
        Macros are estimated
      </label>
      <div className="flex items-center justify-end">
        <SubmitButton size="sm">Save</SubmitButton>
      </div>
    </ActionForm>
  );
}

/**
 * A recipe row without stored per-serving arithmetic cannot be rescaled, and the service refuses
 * an aggregate macro edit while ingredient rows exist (they could not be kept in step). So the
 * totals form is offered only when there are genuinely no child rows; otherwise the card says
 * what the service would say instead of letting the form fail.
 */
function LegacyEdit({ entry }: { entry: LoggedIngredientEntry }) {
  if (entry.ingredients.length > 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        This entry has ingredient rows but no stored per-serving values, so its totals cannot be
        edited here without desynchronising them. Log the serving again from the recipe, or use
        Correct past meals to refresh the ingredients they came from.
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Editing these totals changes only this entry. No ingredient details were recorded, so
        there is no breakdown to keep in step.
      </p>
      <PlainFoodEdit entry={entry} action={updateLegacyEntryAction} />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Meal list
 * ------------------------------------------------------------------------------------------- */

function EntryCard({ entry, timezone }: { entry: LoggedIngredientEntry; timezone: string }) {
  const isRecipe =
    entry.recipeId !== null ||
    entry.recipeServingJson !== null ||
    entry.ingredients.length > 0;
  const stored = parseStoredServing(entry.recipeServingJson);
  const fraction = entry.servingFraction && entry.servingFraction > 0 ? entry.servingFraction : 1;
  const [editing, setEditing] = useState(false);

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="min-w-0 truncate" title={entry.name}>
              {entry.name}
            </span>
            {entry.estimated ? <Tag>estimated</Tag> : null}
            {entry.recipeId !== null && entry.servingNo !== null ? (
              <Tag title="Which serving of the recipe this entry is">serving {entry.servingNo}</Tag>
            ) : null}
            {isRecipe && fraction !== 1 ? <Tag>{num(fraction, 2)} × serving</Tag> : null}
          </p>
          <p className="num text-xs text-muted-foreground">
            {num(entry.grams)} g · {num(entry.proteinG, 1)} g protein
          </p>
        </div>
        <p className="num shrink-0 text-sm">{num(entry.kcal, 0)} kcal</p>
      </div>

      <SnapshotSection entry={entry} />

      <Revisions entry={entry} timezone={timezone} />

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setEditing((current) => !current)}
        aria-expanded={editing}
        className="mt-1 h-11 px-2 text-xs text-muted-foreground sm:h-8"
      >
        {editing ? "Close edit" : "Edit"}
      </Button>

      {editing ? (
        <div className="mt-1">
          {entry.ingredientSnapshotComplete === null ? (
            <PlainFoodEdit entry={entry} />
          ) : entry.ingredientSnapshotComplete === true && stored !== null ? (
            <PortionForm entry={entry} />
          ) : (
            /*
             * A legacy row (ingredients never recorded) or a partial child snapshot. A rescaled
             * portion would either invent the arithmetic or leave missing child rows behind the
             * parent's new totals, so only the cases with no children at all offer a totals edit.
             */
            <LegacyEdit entry={entry} />
          )}
        </div>
      ) : null}

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
  );
}

export function MealList({
  meals,
  timezone,
}: {
  meals: Record<Meal, LoggedIngredientEntry[]>;
  timezone: string;
}) {
  const totals = useMemo(() => {
    const map = {} as Record<Meal, number>;
    for (const { key } of MEALS) {
      map[key] = meals[key].reduce((sum, entry) => sum + entry.kcal, 0);
    }
    return map;
  }, [meals]);

  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      {MEALS.map(({ key, label }) => {
        const entries = meals[key];
        return (
          <section key={key} className="min-w-0 rounded-xl border border-border p-4" aria-labelledby={`meal-${key}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 id={`meal-${key}`} className="text-sm font-medium">{label}</h2>
              <span className="num text-xs text-muted-foreground">{num(totals[key], 0)} kcal</span>
            </div>

            {entries.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">Nothing logged</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/60">
                {entries.map((entry) => (
                  <EntryCard key={entry.id} entry={entry} timezone={timezone} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
