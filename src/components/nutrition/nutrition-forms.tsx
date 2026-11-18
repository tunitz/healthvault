"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Search, Trash2 } from "lucide-react";
import { copyDayAction, setTargetsAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { FoodForm } from "@/components/nutrition/food-forms";
import { MealList } from "@/components/nutrition/meal-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { num } from "@/lib/format";
import {
  basisOptionsForFood,
  draftItemFromFood,
  mealDraftStorageKey,
  mealItemToEntry,
  parseStoredMealDraft,
  serializeMealDraft,
  unitsForFood,
  type EntryPreviewResult,
  type FoodSearchResult,
  type LoggingFoodOption,
  type LoggingPreview,
  type LoggingRecipeOption,
  type MealDraft,
  type MealDraftItem,
  type RecentFoodOption,
  type SaveDraftResult,
} from "@/lib/foods-ui";
import type { LoggedIngredientEntry } from "@/lib/services/food-log-snapshots";
import type { Meal, Targets } from "@/lib/services/nutrition";

const SELECT =
  "h-11 max-sm:h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const MEALS: { value: Meal; label: string }[] = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
];

type SaveInput = {
  day: string;
  meal: string;
  time: string;
  entries: (Record<string, unknown> & { key?: string })[];
  recipes: { recipeId: number; servingFraction: string }[];
};

type DiaryProps = {
  day: string;
  defaultMeal: Meal;
  timezone: string;
  meals: Record<Meal, LoggedIngredientEntry[]>;
  recent: RecentFoodOption[];
  recipes: LoggingRecipeOption[];
  initialFoods: LoggingFoodOption[];
  searchFoods: (query: string) => Promise<FoodSearchResult>;
  previewEntry: (entry: Record<string, unknown>) => Promise<EntryPreviewResult>;
  previewRecipe: (input: { recipeId: number; servingFraction: string }) => Promise<EntryPreviewResult>;
  saveDraft: (input: SaveInput) => Promise<SaveDraftResult>;
};

function uid(prefix = "item"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function MealSelect({ value, onChange, label = "Meal" }: { value: string; onChange: (value: Meal) => void; label?: string }) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as Meal)}
        className={SELECT}
      >
        {MEALS.map((meal) => (
          <option key={meal.value} value={meal.value}>
            {meal.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The diary is the primary surface; Add food and the meal list share one draft. */
export function Diary({
  day,
  defaultMeal,
  timezone,
  meals,
  recent,
  recipes,
  initialFoods,
  searchFoods,
  previewEntry,
  previewRecipe,
  saveDraft,
}: DiaryProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MealDraft>(() => ({ day, meal: defaultMeal, time: "", items: [] }));
  const [hydrated, setHydrated] = useState(false);
  const storageKey = mealDraftStorageKey(day);

  const setMeal = (meal: Meal) => setDraft((current) => ({ ...current, meal }));
  const update = useCallback((patch: Partial<MealDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    // Deferred to a task so hydration never calls setState synchronously in the effect body.
    const handle = setTimeout(() => {
      const stored = parseStoredMealDraft(window.localStorage.getItem(storageKey), day);
      if (stored) setDraft(stored);
      setHydrated(true);
    }, 0);
    return () => clearTimeout(handle);
  }, [storageKey, day]);

  useEffect(() => {
    if (!hydrated) return;
    // The date is editable, so the draft follows it: persist under the selected day and clear a
    // stale copy left under the day the page was opened on.
    const target = mealDraftStorageKey(draft.day);
    if (draft.items.length === 0) window.localStorage.removeItem(target);
    else window.localStorage.setItem(target, serializeMealDraft(draft));
    if (draft.day !== day) window.localStorage.removeItem(storageKey);
  }, [draft, hydrated, day, storageKey]);

  const addToMeal = (meal: Meal) => {
    setMeal(meal);
    setOpen(true);
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Diary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Diary</h2>
          <p className="text-xs text-muted-foreground">Add several items, then save the meal once.</p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls="add-food-panel"
          className="min-h-11"
        >
          <Plus aria-hidden />
          Add food
          {draft.items.length > 0 ? <Badge variant="secondary">{draft.items.length}</Badge> : null}
        </Button>
      </div>

      {open ? (
        <div id="add-food-panel" className="rounded-xl border border-border p-3 sm:p-4">
          <AddFoodPanel
            draft={draft}
            update={update}
            setDraft={setDraft}
            recent={recent}
            recipes={recipes}
            initialFoods={initialFoods}
            searchFoods={searchFoods}
            previewEntry={previewEntry}
            previewRecipe={previewRecipe}
            saveDraft={saveDraft}
            onDone={() => {
              setDraft({ day, meal: draft.meal, time: "", items: [] });
              setOpen(false);
              router.refresh();
            }}
          />
        </div>
      ) : null}

      <MealList meals={meals} timezone={timezone} onAddToMeal={addToMeal} />
    </section>
  );
}

type PanelProps = Omit<DiaryProps, "day" | "defaultMeal" | "timezone" | "meals"> & {
  draft: MealDraft;
  update: (patch: Partial<MealDraft>) => void;
  setDraft: Dispatch<SetStateAction<MealDraft>>;
  onDone: () => void;
};

type PreviewState = { preview?: LoggingPreview; error?: string };

type Tab = "food" | "recipe" | "quick";

function AddFoodPanel({
  draft,
  update,
  setDraft,
  recent,
  recipes,
  initialFoods,
  searchFoods,
  previewEntry,
  previewRecipe,
  saveDraft,
  onDone,
}: PanelProps) {
  const [tab, setTab] = useState<Tab>("food");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LoggingFoodOption[]>(initialFoods);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [saveItemErrors, setSaveItemErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submitGuard = useRef(false);

  // Saved-food search runs on the server over the whole library; only a small page of matches
  // comes back. An empty query keeps the bounded suggestion list already sent with the page.
  useEffect(() => {
    let cancelled = false;
    const needle = query.trim();
    const handle = setTimeout(async () => {
      if (!needle) {
        if (cancelled) return;
        setResults(initialFoods);
        setSearchError(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const response = await searchFoods(needle);
        if (cancelled) return;
        if (response.ok) {
          setResults(response.items);
          setSearchError(null);
        } else {
          setSearchError(response.error);
        }
      } catch {
        if (!cancelled) setSearchError("Search failed. Try again.");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, needle ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, searchFoods, initialFoods]);

  // Live preview uses the service arithmetic through a read-only action. It is debounced so a
  // fast typist does not fire a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      if (draft.items.length === 0) {
        if (!cancelled) setPreviews({});
        return;
      }
      const next: Record<string, PreviewState> = {};
      await Promise.all(
        draft.items.map(async (item) => {
          try {
            let response: EntryPreviewResult;
            if (item.kind === "recipe" && item.recipeId !== undefined) {
              response = await previewRecipe({
                recipeId: item.recipeId,
                servingFraction: item.servingFraction || "1",
              });
            } else {
              const payload = mealItemToEntry(item);
              if (!payload) return;
              response = await previewEntry(payload);
            }
            if (!cancelled) next[item.key] = response.ok ? { preview: response.preview } : { error: response.error };
          } catch {
            if (!cancelled) next[item.key] = { error: "Could not preview" };
          }
        }),
      );
      if (!cancelled) setPreviews(next);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [draft.items, previewEntry, previewRecipe]);

  const addItem = (item: MealDraftItem) => {
    setDraft((current) => ({ ...current, items: [...current.items, item] }));
    setSaveError(null);
  };

  const addFood = (food: LoggingFoodOption) => addItem(draftItemFromFood(food, uid("food")));

  const addRecent = async (row: RecentFoodOption) => {
    if (row.food) {
      addFood(row.food);
      return;
    }
    if (row.foodId !== null) {
      const response = await searchFoods(row.name);
      const match = response.ok ? response.items.find((food) => food.id === row.foodId) : undefined;
      if (match) addFood(match);
      else toast.error("That food is no longer in the library");
      return;
    }
    addItem({
      key: uid("recent"),
      kind: "custom",
      label: row.name,
      quantity: String(Math.round(row.grams)),
      unit: "g",
      basis: "",
      weightSource: "guessed",
      kcal: String(Math.round(row.kcal)),
    });
  };

  const addRecipe = (recipe: LoggingRecipeOption) =>
    addItem({
      key: uid("recipe"),
      kind: "recipe",
      label: recipe.name,
      recipeId: recipe.id,
      quantity: "1",
      unit: "serving",
      basis: "",
      weightSource: "counted",
      servingFraction: "1",
    });

  const patchItem = (key: string, patch: Partial<MealDraftItem>) =>
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }));

  const removeItem = (key: string) =>
    setDraft((current) => ({ ...current, items: current.items.filter((item) => item.key !== key) }));

  const total = useMemo(() => {
    let kcal = 0;
    let proteinG = 0;
    for (const item of draft.items) {
      const preview = previews[item.key]?.preview;
      if (preview) {
        kcal += preview.kcal;
        proteinG += preview.proteinG;
      }
    }
    return { kcal, proteinG };
  }, [draft.items, previews]);

  async function handleSave() {
    if (submitGuard.current || saving) return;
    if (draft.items.length === 0) {
      setSaveError("Add at least one item first");
      return;
    }
    submitGuard.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveItemErrors({});
    const entries = draft.items
      .map((item) => mealItemToEntry(item))
      .filter((entry): entry is Record<string, unknown> & { key?: string } => entry !== null);
    const recipesToLog = draft.items
      .filter((item) => item.kind === "recipe" && item.recipeId !== undefined)
      .map((item) => ({ recipeId: item.recipeId!, servingFraction: item.servingFraction || "1" }));
    try {
      const response = await saveDraft({
        day: draft.day,
        meal: draft.meal,
        time: draft.time,
        entries,
        recipes: recipesToLog,
      });
      if (response.ok) {
        toast.success(response.message);
        onDone();
      } else {
        setSaveError(response.error);
        if (response.itemKey) setSaveItemErrors({ [response.itemKey]: response.error });
      }
    } catch {
      setSaveError("Could not save the meal. Try again.");
    } finally {
      submitGuard.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MealSelect value={draft.meal} onChange={(meal) => update({ meal })} />
        <Field label="Date">
          <Input
            type="date"
            value={draft.day}
            onChange={(event) => update({ day: event.target.value })}
            aria-label="Date"
          />
        </Field>
        <Field label="Time" hint="Optional · blank uses the current time">
          <Input
            type="time"
            value={draft.time}
            onChange={(event) => update({ time: event.target.value })}
            aria-label="Eaten time"
          />
        </Field>
      </div>

      <div role="tablist" aria-label="Add food source" className="flex flex-wrap gap-1">
        {(
          [
            ["food", "Saved food"],
            ["recipe", "Recipe"],
            ["quick", "Quick entry"],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`min-h-11 rounded-lg px-3 text-sm ${
              tab === value ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "food" ? (
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the whole food library"
              aria-label="Search foods"
              className="pl-9"
              autoComplete="off"
            />
          </div>
          {searchError ? <p role="alert" className="text-xs text-destructive">{searchError}</p> : null}
          {recent.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-medium text-muted-foreground">Recent</p>
              <div className="flex flex-wrap gap-1.5">
                {recent.map((row) => (
                  <button
                    key={`${row.name}-${row.foodId ?? "raw"}`}
                    type="button"
                    onClick={() => void addRecent(row)}
                    className="min-h-11 rounded-lg border border-border px-2.5 text-xs hover:bg-muted"
                  >
                    {row.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <ul className="flex max-h-64 flex-col divide-y divide-border/60 overflow-auto rounded-lg border border-border">
            {searching ? <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li> : null}
            {!searching && results.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No foods match that search.</li>
            ) : null}
            {results.map((food) => (
              <li key={food.id}>
                <button
                  type="button"
                  onClick={() => addFood(food)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{food.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {food.brand ? `${food.brand} · ` : ""}{num(food.kcalPer100g, 0)} kcal/100g · {food.state}
                    </span>
                  </span>
                  <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === "recipe" ? (
        recipes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved recipes yet.</p>
        ) : (
          <ul className="flex max-h-64 flex-col divide-y divide-border/60 overflow-auto rounded-lg border border-border">
            {recipes.map((recipe) => (
              <li key={recipe.id}>
                <button
                  type="button"
                  onClick={() => addRecipe(recipe)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="min-w-0 truncate">{recipe.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {!recipe.complete ? <Badge variant="outline">unknown nutrition</Badge> : null}
                    {recipe.servingsTotal} servings
                    <Plus aria-hidden className="size-4" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === "quick" ? <QuickEntry onAdd={addItem} /> : null}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Draft ({draft.items.length})</h3>
          {draft.items.length > 0 ? (
            <span className="num text-xs text-muted-foreground">
              {num(total.kcal, 0)} kcal · {num(total.proteinG, 1)} g protein
            </span>
          ) : null}
        </div>

        {draft.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">Pick a food, recipe or quick entry above to start.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {draft.items.map((item) => (
              <DraftRow
                key={item.key}
                item={item}
                previewState={previews[item.key]}
                error={saveItemErrors[item.key]}
                onPatch={(patch) => patchItem(item.key, patch)}
                onRemove={() => removeItem(item.key)}
              />
            ))}
          </ul>
        )}

        {saveError ? <p role="alert" className="text-xs text-destructive">{saveError}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone} className="min-h-11">
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || draft.items.length === 0}
            aria-busy={saving}
            className="min-h-11"
          >
            {saving ? "Saving…" : `Save ${draft.items.length} ${draft.items.length === 1 ? "item" : "items"}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Saved-food / custom portion editor with an inline nutrition preview from the service. */
function DraftRow({
  item,
  previewState,
  error,
  onPatch,
  onRemove,
}: {
  item: MealDraftItem;
  previewState?: PreviewState;
  error?: string;
  onPatch: (patch: Partial<MealDraftItem>) => void;
  onRemove: () => void;
}) {
  const food = item.food ?? null;
  const units = food ? unitsForFood(food) : ["g"];
  const bases = basisOptionsForFood(food?.state ?? "");
  const preview = previewState?.preview;
  const rowError = error ?? previewState?.error;

  return (
    <li className="rounded-lg border border-border p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium" title={item.label}>{item.label}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="max-sm:size-11"
          onClick={onRemove}
          aria-label={`Remove ${item.label}`}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>

      {item.kind === "recipe" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Servings" hint="Fractions allowed, e.g. 0.5">
            <Input
              type="number"
              inputMode="decimal"
              min="0.01"
              max="100"
              step="0.01"
              value={item.servingFraction ?? "1"}
              onChange={(event) => onPatch({ servingFraction: event.target.value })}
            />
          </Field>
          <p className="flex items-end pb-1 text-xs text-muted-foreground">Named servings, not cooked weight.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr]">
            <Field label={item.unit === "g" ? "Grams" : "Count"}>
              <Input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="any"
                value={item.quantity}
                onChange={(event) => onPatch({ quantity: event.target.value })}
                aria-invalid={!!rowError || undefined}
              />
            </Field>
            <Field label="Unit">
              <select
                value={item.unit}
                onChange={(event) =>
                  onPatch({
                    unit: event.target.value,
                    quantity:
                      event.target.value === "g"
                        ? String(food?.servingGrams ?? 100)
                        : "1",
                  })
                }
                className={SELECT}
              >
                {units.map((unit) => (
                  <option key={unit} value={unit}>{unit}</option>
                ))}
              </select>
            </Field>
            {item.kind === "food" ? (
              <Field label="Weighed as" className="col-span-2 sm:col-span-1">
                <select
                  value={item.basis}
                  onChange={(event) => onPatch({ basis: event.target.value })}
                  className={SELECT}
                >
                  {bases.map((basis) => (
                    <option key={basis.value} value={basis.value}>{basis.label}</option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
          {item.kind === "custom" ? (
            <p className="mt-1 text-[11px] text-muted-foreground">Macros are for the whole portion shown.</p>
          ) : null}
        </>
      )}

      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        {preview ? (
          <span className="num text-muted-foreground">
            {num(preview.kcal, 0)} kcal · {num(preview.proteinG, 1)} g protein
            {preview.rawEquivalentGrams !== preview.grams
              ? ` · ${num(preview.rawEquivalentGrams, 1)} g basis`
              : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">Preview unavailable until the amount is valid.</span>
        )}
        {preview && preview.macroSource === "estimated" ? <Badge variant="outline">estimated</Badge> : null}
      </div>
      {rowError ? <p role="alert" className="mt-1 text-xs text-destructive">{rowError}</p> : null}
    </li>
  );
}

/** Food-less entry. Macros are absolute for the portion; no 100 g default is assumed. */
function QuickEntry({ onAdd }: { onAdd: (item: MealDraftItem) => void }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [kcal, setKcal] = useState("");
  const [proteinG, setProteinG] = useState("0");
  const [carbsG, setCarbsG] = useState("0");
  const [fatG, setFatG] = useState("0");
  const [fibreG, setFibreG] = useState("0");
  const [sodiumMg, setSodiumMg] = useState("0");
  const [estimated, setEstimated] = useState(true);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="e.g. grilled chicken" />
        </Field>
        <Field label="Grams">
          <Input type="number" inputMode="decimal" min="0.1" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </Field>
        <Field label="kcal (whole portion)">
          <Input type="number" inputMode="decimal" min="0" step="any" value={kcal} onChange={(event) => setKcal(event.target.value)} />
        </Field>
        <Field label="Protein (g)">
          <Input type="number" inputMode="decimal" min="0" step="any" value={proteinG} onChange={(event) => setProteinG(event.target.value)} />
        </Field>
      </div>
      <details>
        <summary className="cursor-pointer py-3.5 text-xs text-muted-foreground sm:py-0">More macros</summary>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Carbs (g)">
            <Input type="number" inputMode="decimal" min="0" step="any" value={carbsG} onChange={(event) => setCarbsG(event.target.value)} />
          </Field>
          <Field label="Fat (g)">
            <Input type="number" inputMode="decimal" min="0" step="any" value={fatG} onChange={(event) => setFatG(event.target.value)} />
          </Field>
          <Field label="Fibre (g)">
            <Input type="number" inputMode="decimal" min="0" step="any" value={fibreG} onChange={(event) => setFibreG(event.target.value)} />
          </Field>
          <Field label="Sodium (mg)">
            <Input type="number" inputMode="decimal" min="0" step="any" value={sodiumMg} onChange={(event) => setSodiumMg(event.target.value)} />
          </Field>
        </div>
      </details>
      <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
        <input
          type="checkbox"
          checked={estimated}
          onChange={(event) => setEstimated(event.target.checked)}
          className="size-4 accent-[var(--primary)]"
        />
        Macros are estimated
      </label>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          className="min-h-11"
          onClick={() => {
            if (name.trim() === "") {
              setError("Give the entry a name");
              return;
            }
            if (quantity.trim() === "") {
              setError("Enter the grams for this portion");
              return;
            }
            if (kcal.trim() === "") {
              setError("Enter the kcal for this portion");
              return;
            }
            setError(null);
            onAdd({
              key: uid("quick"),
              kind: "custom",
              label: name.trim(),
              quantity: quantity.trim(),
              unit: "g",
              basis: "",
              weightSource: "weighed",
              kcal,
              proteinG,
              carbsG,
              fatG,
              fibreG,
              sodiumMg,
              estimated,
            });
            setName("");
            setQuantity("");
            setKcal("");
          }}
        >
          <Plus aria-hidden />
          Add to draft
        </Button>
      </div>
    </div>
  );
}

/** The daily New-food action uses the same shared editor as the Foods library. */
export function NewFoodForm() {
  return (
    <details className="rounded-xl border border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">New food</summary>
      <div className="border-t border-border p-4">
        <FoodForm cancelHref="/nutrition" />
      </div>
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
          <summary className="cursor-pointer py-3.5 text-xs text-muted-foreground sm:py-0">More targets</summary>
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
