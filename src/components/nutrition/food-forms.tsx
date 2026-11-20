"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { deleteFoodAction, saveFoodAction } from "@/app/actions";
import { Field, SubmitButton } from "@/components/action-form";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionState, FoodFormState } from "@/lib/action-state";
import type { FoodFormValues } from "@/lib/foods-ui";

const SELECT =
  "h-11 max-sm:h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const STATES = [
  { value: "raw", label: "Raw" },
  { value: "cooked", label: "Cooked" },
  { value: "dry", label: "Dry" },
  { value: "rehydrated", label: "Rehydrated" },
  { value: "none", label: "No basis" },
] as const;

const BASIS_EXPLANATION: Record<string, string> = {
  raw: "Values are for the raw food. Yield factor = cooked grams per raw gram.",
  cooked: "Values are for the food after cooking.",
  dry: "Values are for the dry food (rice, pasta, oats). Yield factor = cooked grams per dry gram.",
  rehydrated: "Values are for the food after rehydrating.",
  none: "Values as sold or eaten; no raw/cooked conversion applies.",
};

const SOURCES = ["manual", "label", "package", "usda", "agent"] as const;

type MeasureDraft = { name: string; grams: string };

/** The shared input is 32 px; a 44 px control is the touch target on phones. */
function FoodInput(props: ComponentProps<typeof Input>) {
  return (
    <Input
      {...props}
      className={props.className ? `max-sm:h-11 ${props.className}` : "max-sm:h-11"}
    />
  );
}

function Section({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-3 text-sm font-medium">
        {title}
        {summary ? <span className="ml-2 text-xs font-normal text-muted-foreground">{summary}</span> : null}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-3">{children}</div>
    </details>
  );
}

/** One food editor, used by both the daily New-food action and the Foods library. */
export function FoodForm({ food, cancelHref }: { food?: FoodFormValues; cancelHref: string }) {
  const router = useRouter();
  const [state, formAction] = useActionState<FoodFormState, FormData>(saveFoodAction, { ok: true });

  const [basis, setBasis] = useState(food?.state ?? "raw");
  const [yieldFactor, setYieldFactor] = useState(String(food?.yieldFactor ?? 1));
  const [rows, setRows] = useState<MeasureDraft[]>(
    (food?.measures ?? []).map((measure) => ({
      name: measure.name,
      grams: String(measure.grams),
    })),
  );

  useEffect(() => {
    if (!state.ok || !state.message || state.foodId === undefined) return;
    const foodId = state.foodId;
    if (state.mode === "update") {
      toast.success("Food updated", {
        description: "Past meals stay unchanged by default.",
        action: {
          label: "Review past meals",
          onClick: () => router.push(`/nutrition/corrections?foodId=${foodId}`),
        },
      });
      return;
    }
    if (state.mode === "create") {
      // Opened from the recipe builder: hand the new id back so it can be auto-selected while
      // the recipe draft (kept in sessionStorage) stays intact.
      if (new URLSearchParams(window.location.search).get("from") === "recipe") {
        try {
          window.localStorage.setItem("healthvault:recipe-created-food", String(foodId));
        } catch {
          // Blocked storage only loses auto-selection; the food itself is saved.
        }
        toast.success("Food saved — returning to recipe");
        router.push("/nutrition/recipes/new");
        return;
      }
      toast.success("Food saved");
    }
  }, [state, router]);

  const sources = food && !SOURCES.includes(food.source as (typeof SOURCES)[number])
    ? [...SOURCES, food.source]
    : SOURCES;
  const stateOptions = STATES.some((option) => option.value === basis)
    ? STATES
    : [...STATES, { value: basis, label: basis }];
  const showYield = basis === "raw" || basis === "dry";
  const basisChanged = food !== undefined && basis !== food.state;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {food ? (
        <>
          <input type="hidden" name="id" value={food.id} />
          <input type="hidden" name="estimatedInitial" value={food.estimated ? "1" : "0"} />
        </>
      ) : null}

      {/* Essential fields first. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <FoodInput name="name" required maxLength={200} defaultValue={food?.name ?? ""} />
        </Field>
        <Field label="Brand" hint="Optional">
          <FoodInput name="brand" maxLength={200} defaultValue={food?.brand ?? ""} />
        </Field>
        <Field label="Serving weight (g)" hint="Default portion for logging">
          <FoodInput
            name="servingGrams"
            type="number"
            inputMode="decimal"
            step="any"
            min="1"
            max="10000"
            defaultValue={food?.servingGrams ?? 100}
          />
        </Field>
        <Field label="Barcode" hint="Optional">
          <FoodInput name="barcode" maxLength={64} defaultValue={food?.barcode ?? ""} />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Nutrition per 100 g</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="kcal">
            <FoodInput
              name="kcal"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              required
              defaultValue={food?.kcalPer100g ?? ""}
            />
          </Field>
          <Field label="Protein (g)">
            <FoodInput
              name="proteinG"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              defaultValue={food?.proteinPer100g ?? 0}
            />
          </Field>
          <Field label="Carbs (g)">
            <FoodInput
              name="carbsG"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              defaultValue={food?.carbsPer100g ?? 0}
            />
          </Field>
          <Field label="Fat (g)">
            <FoodInput
              name="fatG"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              defaultValue={food?.fatPer100g ?? 0}
            />
          </Field>
        </div>
      </fieldset>

      <Section title="Optional nutrients" summary="Fibre, sodium">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fibre (g)">
            <FoodInput
              name="fibreG"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              defaultValue={food?.fibrePer100g ?? 0}
            />
          </Field>
          <Field label="Sodium (mg)">
            <FoodInput
              name="sodiumMg"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              defaultValue={food?.sodiumPer100g ?? 0}
            />
          </Field>
        </div>
      </Section>

      <Section title="Basis & yield" summary={STATES.find((option) => option.value === basis)?.label ?? basis}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Basis">
            <select
              name="state"
              value={basis}
              onChange={(event) => setBasis(event.target.value)}
              className={SELECT}
            >
              {stateOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          {showYield ? (
            <Field
              label="Yield factor"
              hint={basis === "raw" ? "Cooked g per raw g" : "Cooked g per dry g"}
            >
              <FoodInput
                name="yieldFactor"
                type="number"
                inputMode="decimal"
                step="any"
                min="0.01"
                max="10"
                value={yieldFactor}
                onChange={(event) => setYieldFactor(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {BASIS_EXPLANATION[basis] ?? "Per-100 g values in the stored basis."}
        </p>
        {basisChanged ? (
          <p role="status" className="text-xs text-destructive">
            Changing the basis does not convert the stored values.
          </p>
        ) : null}
      </Section>

      <Section title="Household measures" summary="Units valid for this food">
        <p className="text-xs text-muted-foreground">
          Per-food grams per unit. Shared defaults still apply to units you do not list.
        </p>
        {rows.length > 0 ? (
          <div className="hidden grid-cols-[minmax(0,1fr)_5.5rem_auto] items-end gap-2 sm:grid">
            <span className="text-[11px] text-muted-foreground">Unit</span>
            <span className="text-[11px] text-muted-foreground">Grams</span>
            <span className="sr-only">Remove</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No per-food overrides.</p>
        )}
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem_auto]">
            <FoodInput
              name="measureName"
              value={row.name}
              onChange={(event) =>
                setRows((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
              placeholder="e.g. tbsp"
              maxLength={40}
              aria-label={`Measure ${index + 1} unit`}
            />
            <FoodInput
              name="measureGrams"
              type="number"
              inputMode="decimal"
              step="any"
              min="0.01"
              value={row.grams}
              onChange={(event) =>
                setRows((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, grams: event.target.value } : item,
                  ),
                )
              }
              placeholder="grams"
              aria-label={`Measure ${index + 1} grams`}
              className="col-span-1 sm:col-span-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="col-start-2 row-start-1 max-sm:size-11 sm:col-start-auto sm:row-start-auto"
              aria-label={`Remove measure ${row.name.trim() || index + 1}`}
              onClick={() => setRows((current) => current.filter((_, itemIndex) => itemIndex !== index))}
            >
              <X aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setRows((current) => [...current, { name: "", grams: "" }])}>
            <Plus aria-hidden />
            Add measure
          </Button>
        </div>
      </Section>

      <Section title="Provenance" summary={food?.estimated ? "Source · estimated" : "Source and confidence"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source">
            <select name="source" defaultValue={food?.source ?? "manual"} className={SELECT}>
              {sources.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source date" hint="When the values were read">
            <FoodInput name="sourceDate" type="date" defaultValue={food?.sourceDate ?? ""} />
          </Field>
          <Field label="Source URL" hint="Optional" className="sm:col-span-2">
            <FoodInput name="sourceUrl" type="url" maxLength={500} defaultValue={food?.sourceUrl ?? ""} />
          </Field>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
          <input
            type="checkbox"
            name="estimated"
            defaultChecked={food?.estimated ?? false}
            className="size-4 accent-[var(--primary)]"
          />
          Values are estimates
        </label>
      </Section>

      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {food ? (
          <Button asChild variant="ghost" size="sm" className="min-h-11">
            <Link href={cancelHref}>Cancel</Link>
          </Button>
        ) : null}
        <SubmitButton size="sm" className="min-h-11">{food ? "Save changes" : "Save food"}</SubmitButton>
      </div>
    </form>
  );
}

export function DeleteFoodForm({ id, name }: { id: number; name: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(deleteFoodAction, { ok: true });
  const [open, setOpen] = useState(false);
  const confirmedRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // The service's 409 text is the useful part; show it verbatim in a toast rather than
    // stretching the table row with a long inline message.
    if (state.error) toast.error("Food not deleted", { description: state.error });
  }, [state]);

  const confirm = `Delete "${name}"? This cannot be undone. Foods used by logged meals, recipes or meal ingredients cannot be deleted.`;

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
        confirmLabel="Delete food"
        onConfirm={() => {
          confirmedRef.current = true;
          setOpen(false);
          formRef.current?.requestSubmit();
        }}
      />
    </>
  );
}
