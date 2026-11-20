"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
} from "react";
import { ArrowDown, ArrowUp, Eye, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  deleteRecipeAction,
  logRecipeAction,
  previewRecipeServingAction,
  saveRecipeAction,
  searchRecipeFoodsAction,
} from "@/app/actions";
import { Field, SubmitButton } from "@/components/action-form";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  RecipeDeleteState,
  RecipeFormState,
} from "@/lib/action-state";
import { num, plural } from "@/lib/format";
import {
  defaultQuantity,
  preferredUnit,
  recipeDraftFromRows,
  recipeUnits,
  type RecipeDraft,
  type RecipeEditorIngredient,
  type RecipeFoodOption,
  type RecipeLogState,
  type RecipePreviewResult,
  type RecipeServingPreview,
} from "@/lib/recipes-ui";

const SELECT =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-8 md:text-sm dark:bg-input/30";

const MEALS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
] as const;

const STATE_LABEL: Record<string, string> = {
  raw: "raw",
  cooked: "cooked",
  dry: "dry",
  rehydrated: "rehydrated",
  none: "as sold",
};

function macrosLine(macros: {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
}): string {
  return `${num(macros.kcal, 0)} kcal · ${num(macros.proteinG, 1)} g protein · ${num(macros.carbsG, 1)} g carbs · ${num(macros.fatG, 1)} g fat · ${num(macros.fibreG, 1)} g fibre · ${num(macros.sodiumMg, 0)} mg sodium`;
}

function FoodInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input {...props} className={className ? `max-sm:h-11 ${className}` : "max-sm:h-11"} />;
}

/** Client-only key for a newly added Ingredient · Quantity · Unit row. */
function emptyRow(key: string): RecipeEditorIngredient {
  return { key, foodId: null, name: "", quantity: "", unit: "g" };
}

/** New-recipe drafts survive the round trip to the food library; never store secrets in here. */
const DRAFT_KEY = "healthvault:new-recipe-draft";
/** Set by FoodForm when it was opened from this builder, so the new food can be auto-selected. */
const CREATED_FOOD_KEY = "healthvault:recipe-created-food";

type PersistedDraft = {
  name: string;
  servings: string;
  note: string;
  rows: RecipeEditorIngredient[];
  foodCache: Record<number, RecipeFoodOption>;
};

/* ---------------------------------------------------------------------------------------------
 * Food picker (server-backed)
 * ------------------------------------------------------------------------------------------- */

function FoodPicker({
  index,
  selected,
  onSelect,
  onClear,
}: {
  index: number;
  selected: RecipeFoodOption | null;
  onSelect: (food: RecipeFoodOption) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(selected === null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecipeFoodOption[]>([]);
  const [searching, setSearching] = useState(selected === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      let result: Awaited<ReturnType<typeof searchRecipeFoodsAction>>;
      try {
        result = await searchRecipeFoodsAction(query.trim());
      } catch {
        if (!active) return;
        setSearching(false);
        setResults([]);
        setError("Search failed — try again");
        return;
      }
      if (!active) return;
      setSearching(false);
      if (result.ok) {
        setResults(result.items);
        setError(null);
      } else {
        setResults([]);
        setError(result.error);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  function choose(food: RecipeFoodOption) {
    onSelect(food);
    setOpen(false);
    setQuery("");
    setResults([]);
    setError(null);
    setSearching(false);
  }

  if (selected && !open) {
    return (
      <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5">
        <span className="min-w-0 truncate text-sm" title={selected.name}>
          {selected.name}
          {selected.brand ? <span className="text-muted-foreground"> · {selected.brand}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => {
            setOpen(true);
            setSearching(true);
          }}>
            Change
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-11"
            aria-label={`Clear food for ingredient ${index + 1}`}
            onClick={onClear}
          >
            <X aria-hidden />
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <Input
          type="search"
          value={query}
          placeholder="Search saved foods"
          aria-label={`Search saved foods for ingredient ${index + 1}`}
          autoComplete="off"
          maxLength={120}
          className="max-sm:h-11 flex-1"
          onChange={(event) => {
            setSearching(true);
            setQuery(event.target.value);
          }}
          onFocus={() => {
            if (!open) setSearching(true);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!searching && results[0]) choose(results[0]);
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {selected ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setOpen(false);
              setQuery("");
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <p role="status" className="sr-only">
            {searching ? "Searching saved foods" : `${results.length} saved foods found`}
          </p>
          {searching ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
          ) : error ? (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs">
              <p className="text-muted-foreground">No saved foods match.</p>
              <Link
                href="/nutrition/foods?from=recipe"
                className="mt-1 inline-block text-primary underline underline-offset-4"
              >
                Create a food in the library
              </Link>
              <span className="text-muted-foreground"> · you return here with it selected.</span>
            </div>
          ) : (
            <ul aria-label={`Saved foods for ingredient ${index + 1}`} className="max-h-56 overflow-auto py-1">
              {results.map((food) => (
                <li key={food.id}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full min-w-0 flex-col justify-center gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent sm:min-h-0"
                    onClick={() => choose(food)}
                  >
                    <span className="truncate font-medium">{food.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {food.brand ? `${food.brand} · ` : ""}
                      {num(food.servingGrams)} g serving · {STATE_LABEL[food.state] ?? food.state}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Ingredient row
 * ------------------------------------------------------------------------------------------- */

function IngredientRow({
  row,
  index,
  total,
  selected,
  sharedDefaults,
  onChange,
  onMove,
  onRemove,
  onSelectFood,
  onClearFood,
}: {
  row: RecipeEditorIngredient;
  index: number;
  total: number;
  selected: RecipeFoodOption | null;
  sharedDefaults: Record<string, number>;
  onChange: (patch: Partial<RecipeEditorIngredient>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onSelectFood: (food: RecipeFoodOption) => void;
  onClearFood: () => void;
}) {
  // Only grams plus units this food actually declares — never a blind tbsp/cup default.
  const units = selected ? recipeUnits(selected, sharedDefaults) : ["g"];
  const needsLink = row.foodId === null && row.name.trim() !== "";

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Ingredient {index + 1}</span>
        <span className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-11"
            aria-label={`Move ingredient ${index + 1} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-11"
            aria-label={`Move ingredient ${index + 1} down`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-11"
            aria-label={`Remove ingredient ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden />
          </Button>
        </span>
      </div>

      {needsLink ? (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning/15 px-2.5 py-1.5 text-xs">
          “{row.name}” has no linked food. Choose a saved food to keep it; its nutrition stays unknown
          until then.
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_6rem] sm:items-end">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Ingredient</span>
          <FoodPicker index={index} selected={selected} onSelect={onSelectFood} onClear={onClearFood} />
        </div>
        <Field label="Quantity" hint="Whole batch">
          <FoodInput
            type="number"
            inputMode="decimal"
            min={row.unit === "g" ? "0.1" : "0.01"}
            max="20000"
            step="any"
            value={row.quantity}
            placeholder={row.unit === "g" ? "100" : "1"}
            disabled={row.foodId === null}
            onChange={(event) => onChange({ quantity: event.target.value })}
          />
        </Field>
        <Field label="Unit">
          <select
            value={row.unit}
            disabled={!selected}
            onChange={(event) => onChange({ unit: event.target.value })}
            className={SELECT}
          >
            {units.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Preview panel
 * ------------------------------------------------------------------------------------------- */

export function ServingPreviewPanel({
  preview,
  title = "Preview",
}: {
  preview: RecipeServingPreview;
  title?: string;
}) {
  const anyResolved = preview.ingredients.some((ingredient) => ingredient.resolved);
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">Read-only preview · not saved yet</span>
      </div>

      {!preview.complete ? (
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-foreground">
          <p className="font-medium">Incomplete — nutrition unknown for {plural(preview.unresolvedIngredients.length, "ingredient")}.</p>
          <p className="mt-0.5 text-muted-foreground">
            {preview.unresolvedIngredients.join(", ")}. Their amounts are kept; the macros below
            cover resolved ingredients only and carry no invented calories for the rest.
          </p>
        </div>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2 text-sm">
        <div className="rounded-lg bg-muted/50 p-3">
          <dt className="text-xs text-muted-foreground">
            {preview.complete
              ? "Whole batch"
              : anyResolved
                ? "Whole batch · macros resolved only"
                : "Whole batch · macros unknown"}
          </dt>
          <dd className="num mt-0.5">{num(preview.batch.grams)} g</dd>
          <dd className="num mt-1 text-xs text-muted-foreground">
            {anyResolved ? macrosLine(preview.batch.macros) : "Nutrition unknown — no resolved ingredients"}
          </dd>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <dt className="text-xs text-muted-foreground">
            {preview.servingFraction === 1
              ? preview.complete
                ? "One serving"
                : anyResolved
                  ? "One serving · macros resolved only"
                  : "One serving · macros unknown"
              : `Portion · ${num(preview.servingFraction, 2)} servings${
                  preview.complete ? "" : anyResolved ? " · macros resolved only" : " · macros unknown"
                }`}
          </dt>
          <dd className="num mt-0.5">{num(preview.total.grams)} g</dd>
          <dd className="num mt-1 text-xs text-muted-foreground">
            {anyResolved ? macrosLine(preview.total.macros) : "Nutrition unknown — no resolved ingredients"}
          </dd>
        </div>
      </dl>

      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">Ingredients in this portion</p>
        <ul className="mt-1 divide-y divide-border/60">
          {preview.ingredients.map((ingredient) => (
            <li key={ingredient.ingredientId} className="flex flex-col gap-0.5 py-2 text-xs sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <span className="min-w-0">
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  <span className="min-w-0 truncate text-sm" title={ingredient.name}>
                    {ingredient.name}
                  </span>
                  {!ingredient.resolved ? (
                    <Badge variant="outline">unresolved</Badge>
                  ) : ingredient.source === "estimated" ? (
                    <Badge variant="outline">estimated</Badge>
                  ) : null}
                </span>
                <span className="num block text-muted-foreground">
                  {num(ingredient.grams)} g
                  {ingredient.measure
                    ? ` · recipe measure ${num(ingredient.measure.count)} × ${ingredient.measure.name}`
                    : ""}
                  {ingredient.gramsAs && ingredient.gramsAs !== "none" ? ` · weighed as ${ingredient.gramsAs}` : ""}
                  {preview.amountBasis !== null
                    ? ingredient.amountBasis === "batch"
                      ? " · batch amount"
                      : ingredient.amountBasis === "serving"
                        ? " · one-serving amount"
                        : ""
                    : ""}
                </span>
              </span>
              <span className="num shrink-0 text-muted-foreground sm:text-right">
                {ingredient.resolved
                  ? macrosLine(ingredient.macros)
                  : "Nutrition unknown — unresolved ingredient"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Recipe editor
 * ------------------------------------------------------------------------------------------- */

export type RecipeEditorValues = {
  id: number;
  name: string;
  servingsTotal: number;
  note: string | null;
  ingredients: RecipeEditorIngredient[];
};

export function RecipeEditor({
  recipe,
  initialFoods,
  defaultMeasures,
  cancelHref,
}: {
  recipe?: RecipeEditorValues;
  initialFoods: RecipeFoodOption[];
  defaultMeasures: Record<string, number>;
  cancelHref: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState<RecipeFormState, FormData>(saveRecipeAction, {
    ok: true,
  });
  // A new-recipe draft is restored after creating a missing food in the library. Editing an
  // existing recipe always loads its stored definition instead.
  const [restored] = useState<PersistedDraft | null>(() => {
    if (recipe || typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedDraft;
      return Array.isArray(parsed?.rows) && typeof parsed.name === "string" ? parsed : null;
    } catch {
      return null;
    }
  });
  const [name, setName] = useState(restored?.name ?? recipe?.name ?? "");
  const [servings, setServings] = useState(restored?.servings ?? String(recipe?.servingsTotal ?? 2));
  const [note, setNote] = useState(restored?.note ?? recipe?.note ?? "");
  const [rows, setRows] = useState<RecipeEditorIngredient[]>(
    restored?.rows ?? (recipe?.ingredients.length ? recipe.ingredients : [emptyRow("new-0")]),
  );
  const [foodCache, setFoodCache] = useState<Record<number, RecipeFoodOption>>(() =>
    restored?.foodCache ?? Object.fromEntries(initialFoods.map((food) => [food.id, food])),
  );
  const [preview, setPreview] = useState<{ key: string; result: RecipePreviewResult } | null>(null);
  const [previewing, startPreview] = useTransition();
  const [localError, setLocalError] = useState<string | null>(null);
  const keyRef = useRef(100);

  const draft = useMemo(() => recipeDraftFromRows(rows, name, servings, note), [
    rows,
    name,
    servings,
    note,
  ]);
  const draftKey = draft.ok ? JSON.stringify(draft.draft) : null;
  const currentPreview =
    preview !== null && draftKey !== null && preview.key === draftKey ? preview.result : null;

  useEffect(() => {
    if (!draft.ok) return;
    const key = JSON.stringify(draft.draft);
    const body: RecipeDraft = draft.draft;
    const timer = setTimeout(() => {
      startPreview(async () => {
        try {
          const result = await previewRecipeServingAction({
            draft: {
              name: body.name,
              servings: body.servings,
              ingredients: body.ingredients,
            },
          });
          setPreview({ key, result });
        } catch {
          setPreview({ key, result: { ok: false, error: "Preview failed — try again" } });
        }
      });
    }, 450);
    return () => clearTimeout(timer);
  }, [draft, startPreview]);

  // Best-effort draft persistence: no secrets go in here, and a failed write is harmless.
  useEffect(() => {
    if (recipe || typeof window === "undefined") return;
    try {
      const draftToSave: PersistedDraft = { name, servings, note, rows, foodCache };
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draftToSave));
    } catch {
      // Storage may be unavailable or full; the form still works without a preserved draft.
    }
  }, [recipe, name, servings, note, rows, foodCache]);

  // Returning from "Create a food in the library": auto-select the new food into the first
  // unassigned ingredient row. The draft itself survives in sessionStorage, so only the id
  // needs to cross the round trip. Never leave a stale id behind for a later recipe.
  useEffect(() => {
    if (recipe) return;
    let createdId: number | null = null;
    try {
      const raw = window.localStorage.getItem(CREATED_FOOD_KEY);
      window.localStorage.removeItem(CREATED_FOOD_KEY);
      if (raw && /^\d+$/.test(raw)) createdId = Number(raw);
    } catch {
      return;
    }
    if (createdId === null) return;
    let active = true;
    void searchRecipeFoodsAction("").then((result) => {
      if (!active || !result.ok) return;
      const food = result.items.find((item) => item.id === createdId);
      if (!food) return;
      const target = rows.find((row) => row.foodId === null);
      if (!target) return;
      selectFood(target.key, food);
      toast.success(`${food.name} added to the recipe`);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe]);

  useEffect(() => {
    if (!state.ok || state.recipeId === undefined) return;
    try {
      window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Saving succeeded; a stale draft left behind by blocked storage is not a failure.
    }
    toast.success(state.mode === "update" ? "Recipe updated" : "Recipe saved", {
      description: "Already-logged meals keep their own ingredient snapshots.",
    });
    router.replace(`/nutrition/recipes/${state.recipeId}`);
  }, [state, router]);

  function updateRow(key: string, patch: Partial<RecipeEditorIngredient>) {
    setLocalError(null);
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    setLocalError(null);
    const key = `new-${keyRef.current}`;
    keyRef.current += 1;
    setRows((current) => [...current, emptyRow(key)]);
  }

  function moveRow(index: number, delta: number) {
    setLocalError(null);
    setRows((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function selectFood(key: string, food: RecipeFoodOption) {
    setLocalError(null);
    setFoodCache((current) => ({ ...current, [food.id]: food }));
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row;
        // Selecting a food supplies its preferred unit and a visible default quantity, so a
        // 2-egg or 3-clove entry needs no manual gram arithmetic. An amount already entered (for
        // example on a legacy grams row being linked) keeps its unit so the number is not
        // reinterpreted as a different item.
        const validUnits = recipeUnits(food, defaultMeasures);
        const unit =
          row.quantity !== "" && validUnits.includes(row.unit)
            ? row.unit
            : preferredUnit(food, defaultMeasures);
        return {
          ...row,
          foodId: food.id,
          name: food.name,
          unit,
          quantity: row.quantity === "" ? String(defaultQuantity(food, unit)) : row.quantity,
        };
      }),
    );
  }

  const previewPending = draft.ok && currentPreview === null && !previewing;
  const visibleError = localError ?? state.error ?? null;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-6"
      onChange={() => {
        if (localError) setLocalError(null);
      }}
      onSubmit={(event) => {
        if (!draft.ok) {
          event.preventDefault();
          setLocalError(draft.error);
          return;
        }
        setLocalError(null);
      }}
    >
      <input type="hidden" name="ingredients" value={draft.ok ? JSON.stringify(draft.draft.ingredients) : "[]"} />
      {recipe ? <input type="hidden" name="id" value={recipe.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <Field label="Recipe name">
          <FoodInput
            name="name"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Chicken adobo"
          />
        </Field>
        <Field label="Servings" hint="Whole number, 1–100">
          <FoodInput
            name="servings"
            type="number"
            inputMode="numeric"
            min="1"
            max="100"
            step="1"
            required
            value={servings}
            onChange={(event) => setServings(event.target.value)}
          />
        </Field>
      </div>

      <Field label="Description" hint="Optional">
        <FoodInput
          name="note"
          maxLength={2000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Cooking method, source, etc."
        />
      </Field>

      <section className="flex flex-col gap-2" aria-label="Ingredients">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Ingredients</h2>
          <span className="text-xs text-muted-foreground">
            {plural(rows.length, "ingredient")} · amounts are for the whole batch
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add at least one ingredient.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <IngredientRow
                key={row.key}
                row={row}
                index={index}
                total={rows.length}
                selected={row.foodId === null ? null : foodCache[row.foodId] ?? null}
                sharedDefaults={defaultMeasures}
                onChange={(patch) => updateRow(row.key, patch)}
                onMove={(delta) => moveRow(index, delta)}
                onRemove={() => {
                  setLocalError(null);
                  setRows((current) => current.filter((item) => item.key !== row.key));
                }}
                onSelectFood={(food) => selectFood(row.key, food)}
                onClearFood={() => updateRow(row.key, { foodId: null })}
              />
            ))}
          </ol>
        )}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={rows.length >= 100}>
            <Plus aria-hidden />
            Add ingredient
          </Button>
        </div>
      </section>

      <section aria-label="Totals preview" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Totals</h2>
        {!draft.ok ? (
          <p className="text-xs text-muted-foreground">
            Totals appear once every ingredient has a saved food and a quantity. {draft.error}.
          </p>
        ) : previewing || previewPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Calculating…
          </p>
        ) : currentPreview && !currentPreview.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {currentPreview.error}
          </p>
        ) : currentPreview && currentPreview.ok ? (
          <ServingPreviewPanel
            preview={currentPreview.preview}
            title="Batch and per-serving totals"
          />
        ) : null}
      </section>

      {visibleError ? (
        <p role="alert" className="text-xs text-destructive">
          {visibleError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link
            href={cancelHref}
            onClick={() => {
              try {
                window.sessionStorage.removeItem(DRAFT_KEY);
              } catch {
                // Best-effort cleanup; nothing sensitive is stored.
              }
            }}
          >
            Cancel
          </Link>
        </Button>
        <SubmitButton size="sm" pendingLabel="Saving…">{recipe ? "Save changes" : "Save recipe"}</SubmitButton>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Delete
 * ------------------------------------------------------------------------------------------- */

export function DeleteRecipeForm({
  id,
  name,
  returnTo,
}: {
  id: number;
  name: string;
  /** The detail page returns to the list; the list itself just refreshes. */
  returnTo?: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState<RecipeDeleteState, FormData>(deleteRecipeAction, {
    ok: true,
  });
  const [open, setOpen] = useState(false);
  const confirmedRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.ok || !state.message) return;
    if (state.archived) {
      toast.success(state.message ?? "Archived — logged meals stay intact", {
        description: "Logged meals keep their ingredient snapshots.",
      });
    } else if (state.deleted) {
      toast.success("Recipe deleted");
    }
    // The detail page is redirected by the server action (so a deleted detail route is never
    // re-rendered as 404); the list itself just refreshes after its own delete.
    if (!returnTo) router.refresh();
  }, [state, router, returnTo]);

  useEffect(() => {
    if (state.error) toast.error("Recipe not deleted", { description: state.error });
  }, [state]);

  const confirm = `Delete "${name}"? If it has logged history it will be archived instead of deleted, and logged meals stay intact. An unreferenced recipe is permanently deleted.`;

  return (
    <>
      <form
        ref={formRef}
        action={formAction}
        onSubmit={(event) => {
          if (!confirmedRef.current) {
            event.preventDefault();
            setOpen(true);
            return;
          }
          confirmedRef.current = false;
        }}
      >
        <input type="hidden" name="id" value={id} />
        {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
        <SubmitButton
          variant="ghost"
          size="icon-sm"
          className="max-sm:size-11"
          aria-label={`Delete ${name}`}
          title={`Delete ${name}`}
          pendingLabel={<span className="sr-only">Deleting</span>}
        >
          <Trash2 aria-hidden />
        </SubmitButton>
      </form>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${name}?`}
        description={confirm}
        confirmLabel="Delete recipe"
        onConfirm={() => {
          confirmedRef.current = true;
          setOpen(false);
          formRef.current?.requestSubmit();
        }}
      />
    </>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Log a serving
 * ------------------------------------------------------------------------------------------- */

export type LogIngredient = {
  id: number;
  name: string;
  resolved: boolean;
  grams: number;
  measure: { name: string; count: number } | null;
  state: string | null;
  yieldFactor: number | null;
  /** One serving of the recipe. */
  perServingGrams: number;
};

type OverrideDraft = { enabled: boolean; grams: string; gramsAs: string };

export function RecipeLogForm({
  recipeId,
  servingsTotal,
  ingredients,
  initialServingNo,
  today,
  defaultMeal,
  timezone,
}: {
  recipeId: number;
  servingsTotal: number;
  ingredients: LogIngredient[];
  initialServingNo: number | null;
  today: string;
  defaultMeal: (typeof MEALS)[number]["key"];
  timezone: string;
}) {
  const [state, formAction] = useActionState<RecipeLogState, FormData>(logRecipeAction, {
    ok: true,
  });
  const [servingFraction, setServingFraction] = useState("1");
  const [amountBasis, setAmountBasis] = useState<"" | "batch" | "serving">("");
  const [overrides, setOverrides] = useState<Record<number, OverrideDraft>>(() =>
    Object.fromEntries(
      ingredients.map((ingredient) => [
        ingredient.id,
        {
          enabled: false,
          grams: String(Number(ingredient.perServingGrams.toFixed(4))),
          gramsAs: "",
        },
      ]),
    ),
  );
  const [preview, setPreview] = useState<{ key: string; result: RecipePreviewResult } | null>(null);
  const [previewing, startPreview] = useTransition();
  const [localError, setLocalError] = useState<string | null>(null);

  const enabled = ingredients.filter((ingredient) => overrides[ingredient.id]?.enabled);
  const hasOverrides = enabled.length > 0;

  useEffect(() => {
    if (!state.ok || !state.message) return;
    toast.success("Recipe logged", {
      description: state.message,
    });
  }, [state]);

  // Overrides belong to this log only: the recipe itself is never rewritten.
  const overridePayload = useMemo(() => {
    const rows: { ingredientId: number; grams?: number; gramsAs?: "raw" | "cooked" }[] = [];
    for (const ingredient of ingredients) {
      const draft = overrides[ingredient.id];
      if (!draft?.enabled) continue;
      const grams = Number(draft.grams);
      rows.push({
        ingredientId: ingredient.id,
        ...(Number.isFinite(grams) ? { grams } : {}),
        ...(draft.gramsAs === "raw" || draft.gramsAs === "cooked"
          ? { gramsAs: draft.gramsAs }
          : {}),
      });
    }
    return rows;
  }, [ingredients, overrides]);

  const previewKey = JSON.stringify({
    servingFraction,
    ...(hasOverrides ? { amountBasis, overrides: overridePayload } : {}),
  });
  const currentPreview =
    preview !== null && preview.key === previewKey ? preview.result : null;

  function validateOverrides(): string | null {
    for (const ingredient of enabled) {
      const grams = Number(overrides[ingredient.id]?.grams);
      if (!Number.isFinite(grams) || grams < 0.1 || grams > 20_000) {
        return `${ingredient.name}: override grams must be between 0.1 and 20000`;
      }
    }
    if (hasOverrides && amountBasis === "") {
      return "Choose how to apply the overrides: whole batch or one serving";
    }
    return null;
  }

  function previewInput(): Record<string, unknown> {
    return {
      recipeId,
      servingFraction,
      ...(hasOverrides
        ? { ingredientOverrides: overridePayload, amountBasis }
        : {}),
    };
  }

  function runPreview() {
    const problem = validateOverrides();
    setPreview(null);
    if (problem) {
      setLocalError(problem);
      return;
    }
    const key = previewKey;
    setLocalError(null);
    startPreview(async () => {
      try {
        const result = await previewRecipeServingAction(previewInput());
        setPreview({ key, result });
      } catch {
        setPreview({ key, result: { ok: false, error: "Preview failed — try again" } });
      }
    });
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      onChange={() => {
        if (localError) setLocalError(null);
      }}
      onSubmit={(event) => {
        if (initialServingNo === null) {
          event.preventDefault();
          setLocalError("All servings are already logged");
          return;
        }
        const problem = validateOverrides();
        if (problem) {
          event.preventDefault();
          setLocalError(problem);
          return;
        }
        setLocalError(null);
        setPreview(null);
      }}
    >
      <input type="hidden" name="recipeId" value={recipeId} />
      <input
        type="hidden"
        name="ingredientOverrides"
        value={hasOverrides ? JSON.stringify(overridePayload) : "[]"}
      />

      {initialServingNo === null ? (
        <p role="status" className="rounded-lg border border-border px-3 py-2 text-sm">
          All {servingsTotal} servings are already logged. Review the logged portions from the
          Nutrition day view.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Day">
          <FoodInput type="date" name="day" defaultValue={today} required />
        </Field>
        <Field label="Meal">
          <select name="meal" defaultValue={defaultMeal} className={SELECT}>
            {MEALS.map((meal) => (
              <option key={meal.key} value={meal.key}>
                {meal.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Serving number"
          hint={
            initialServingNo === null
              ? "All logged"
              : `1–${servingsTotal} · next unlogged ${initialServingNo}`
          }
        >
          <FoodInput
            key={initialServingNo ?? "all-logged"}
            type="number"
            name="servingNo"
            inputMode="numeric"
            min="1"
            max={servingsTotal}
            step="1"
            defaultValue={initialServingNo ?? ""}
            placeholder={initialServingNo === null ? "All logged" : undefined}
            disabled={initialServingNo === null}
          />
        </Field>
        <Field label="Portion" hint="1 = one whole serving">
          <FoodInput
            type="number"
            name="servingFraction"
            inputMode="decimal"
            min="0.01"
            max="100"
            step="0.01"
            value={servingFraction}
            onChange={(event) => setServingFraction(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Eaten time" hint={`Optional · ${timezone}`}>
        <FoodInput type="time" name="time" className="sm:max-w-[10rem]" />
      </Field>

      <section aria-label="Amounts for this meal" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Amounts for this meal</h3>
          <span className="text-xs text-muted-foreground">
            {plural(ingredients.length, "ingredient")} · recipe is not changed
          </span>
        </div>

        <ul className="flex flex-col gap-2">
          {ingredients.map((ingredient) => {
            const draft = overrides[ingredient.id] ?? {
              enabled: false,
              grams: "",
              gramsAs: "",
            };
            return (
              <li key={ingredient.id} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                      <span className="min-w-0 truncate" title={ingredient.name}>
                        {ingredient.name}
                      </span>
                      {!ingredient.resolved ? (
                        <Badge variant="outline">nutrition unknown</Badge>
                      ) : null}
                    </p>
                    <p className="num text-xs text-muted-foreground">
                      {num(ingredient.perServingGrams)} g per serving · {num(ingredient.grams)} g in the batch
                      {ingredient.measure
                        ? ` · recipe measure ${num(ingredient.measure.count)} × ${ingredient.measure.name}`
                        : ""}
                      {ingredient.state ? ` · ${STATE_LABEL[ingredient.state] ?? ingredient.state} basis` : ""}
                    </p>
                  </div>
                  <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setOverrides((current) => ({
                          ...current,
                          [ingredient.id]: {
                            ...(current[ingredient.id] ?? draft),
                            enabled: event.target.checked,
                          },
                        }))
                      }
                      className="size-4 accent-[var(--primary)]"
                    />
                    Change amount
                  </label>
                </div>

                {draft.enabled ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <Field
                      label="Grams"
                      hint={
                        amountBasis === "batch"
                          ? "Grams for the whole batch"
                          : amountBasis === "serving"
                            ? "Grams for one serving"
                            : "Choose the basis below"
                      }
                    >
                      <FoodInput
                        type="number"
                        inputMode="decimal"
                        min="0.1"
                        max="20000"
                        step="any"
                        value={draft.grams}
                        onChange={(event) =>
                          setOverrides((current) => ({
                            ...current,
                            [ingredient.id]: {
                              ...(current[ingredient.id] ?? draft),
                              grams: event.target.value,
                            },
                          }))
                        }
                      />
                    </Field>
                    {ingredient.resolved &&
                    ingredient.state !== null &&
                    ingredient.state !== "none" &&
                    (ingredient.yieldFactor ?? 1) !== 1 ? (
                      <Field label="Weighed as" hint="Converts to the food’s basis">
                        <select
                          value={draft.gramsAs}
                          onChange={(event) =>
                            setOverrides((current) => ({
                              ...current,
                              [ingredient.id]: {
                                ...(current[ingredient.id] ?? draft),
                                gramsAs: event.target.value,
                              },
                            }))
                          }
                          className={SELECT}
                        >
                          <option value="">As stored</option>
                          <option value="raw">Raw</option>
                          <option value="cooked">Cooked</option>
                        </select>
                      </Field>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3" disabled={!hasOverrides}>
          <legend className="px-1 text-xs font-medium">Override amounts are</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            <label className="flex min-h-11 items-start gap-2 text-xs sm:min-h-0">
              <input
                type="radio"
                name="amountBasis"
                value="batch"
                required={hasOverrides}
                checked={amountBasis === "batch"}
                onChange={() => setAmountBasis("batch")}
                className="mt-0.5 size-4 accent-[var(--primary)]"
              />
              <span>
                <span className="block font-medium text-foreground">For the whole batch</span>
                <span className="text-muted-foreground">Divided by {servingsTotal} servings.</span>
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-2 text-xs sm:min-h-0">
              <input
                type="radio"
                name="amountBasis"
                value="serving"
                required={hasOverrides}
                checked={amountBasis === "serving"}
                onChange={() => setAmountBasis("serving")}
                className="mt-0.5 size-4 accent-[var(--primary)]"
              />
              <span>
                <span className="block font-medium text-foreground">Already one serving</span>
                <span className="text-muted-foreground">Used as entered for this portion.</span>
              </span>
            </label>
          </div>
          {hasOverrides ? null : (
            <p className="text-xs text-muted-foreground">Only needed when you change an ingredient amount.</p>
          )}
        </fieldset>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
          <Eye aria-hidden />
          {previewing ? "Calculating…" : "Preview"}
        </Button>
        <SubmitButton
          size="sm"
          pendingLabel="Logging…"
          disabled={initialServingNo === null}
        >
          Log serving
        </SubmitButton>
      </div>

      {localError ?? state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {localError ?? state.error}
        </p>
      ) : null}

      {preview !== null && currentPreview === null && !previewing ? (
        <p className="text-xs text-muted-foreground">
          Inputs changed since this preview — run Preview again to see the current totals.
        </p>
      ) : null}

      {currentPreview ? (
        currentPreview.ok ? (
          <ServingPreviewPanel preview={currentPreview.preview} title="What will be saved" />
        ) : (
          <p role="alert" className="text-xs text-destructive">
            {currentPreview.error}
          </p>
        )
      ) : null}

      {state.ok && state.day ? (
        <p role="status" className="rounded-lg border border-border px-3 py-2 text-sm">
          Logged serving {state.servingNo ?? "—"} for {state.day}.{" "}
          <Link className="text-primary underline underline-offset-4" href={`/nutrition?day=${state.day}`}>
            View day totals
          </Link>
        </p>
      ) : null}
    </form>
  );
}
