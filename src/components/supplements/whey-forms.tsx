"use client";

import { useCallback, useMemo, useState } from "react";
import { logWheyAction, saveWheyLinkAction, undoWheyAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { LogDialog } from "@/components/log-dialog";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { WheyLink } from "@/lib/services/profile";

const SELECT =
  "h-8 max-sm:h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const MEALS = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
];

export type WheyFoodOption = {
  id: number;
  name: string;
  brand: string | null;
  kcalPer100g: number;
};

export type WheySupplementOption = {
  id: number;
  name: string;
  active: boolean;
};

/** Logging the configured whey serving happens in a popup; Undo stays a single undo action. */
export function WheyLogButtons({ configured, canUndo }: { configured: boolean; canUndo: boolean }) {
  // Undo succeeds outside the Log form's own action state, so remount that form to clear a
  // stale "Already logged..." error (the duplicate guard) without waiting for a page reload.
  const [logFormKey, setLogFormKey] = useState(0);
  const [open, setOpen] = useState(false);
  const clearLogState = useCallback(() => setLogFormKey((key) => key + 1), []);
  if (!configured && !canUndo) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      {configured && !canUndo ? (
        <>
          <Button type="button" onClick={() => setOpen(true)}>
            Log whey
          </Button>
          <LogDialog
            open={open}
            onOpenChange={setOpen}
            title="Log whey"
            description="Records the configured serving and marks the linked supplement for today."
            size="sm"
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button type="submit" form="whey-log-form">Log whey</Button>
              </>
            }
          >
            <ActionForm id="whey-log-form" key={logFormKey} action={logWheyAction} onSuccess={() => setOpen(false)}>
              <p className="text-sm text-muted-foreground">
                One serving will be added to today&apos;s diary. You can undo it afterwards.
              </p>
            </ActionForm>
          </LogDialog>
        </>
      ) : null}
      {canUndo ? (
        <ActionForm action={undoWheyAction} onSuccess={clearLogState}>
          <SubmitButton size="sm" variant="outline">
            Undo
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}

export function WheySetupForm({
  foods,
  supplements,
  link,
}: {
  foods: WheyFoodOption[];
  supplements: WheySupplementOption[];
  link: WheyLink | null;
}) {
  const [query, setQuery] = useState("");
  // The list is the service's most recent 100; the filter keeps an older linked food visible.
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? foods.filter(
          (food) =>
            food.name.toLowerCase().includes(needle) ||
            (food.brand ?? "").toLowerCase().includes(needle),
        )
      : foods;
    if (link && !matches.some((food) => food.id === link.foodId)) {
      const linked = foods.find((food) => food.id === link.foodId);
      if (linked) return [linked, ...matches];
    }
    return matches;
  }, [foods, link, query]);

  return (
    <div className="flex flex-col gap-2">
      <details className="rounded-xl border border-border" open={link === null && foods.length > 0}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          {link ? "Change one-tap whey" : "Configure one-tap whey"}
        </summary>
        {foods.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            No saved foods yet. Add a whey food on Nutrition first.
          </p>
        ) : (
          <ActionForm action={saveWheyLinkAction} className="grid gap-3 border-t border-border p-4">
            <Field label="Search saved foods">
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="e.g. whey"
                maxLength={120}
              />
            </Field>
            <Field label="Whey food">
              <select
                name="foodId"
                defaultValue={link ? String(link.foodId) : options[0] ? String(options[0].id) : ""}
                className={SELECT}
                required
              >
                {options.length === 0 ? <option value="">No match</option> : null}
                {options.map((food) => (
                  <option key={food.id} value={food.id}>
                    {food.name}
                    {food.brand ? ` · ${food.brand}` : ""} · {Math.round(food.kcalPer100g)} kcal/100 g
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Supplement (optional)">
                <select
                  name="supplementId"
                  defaultValue={link?.supplementId ? String(link.supplementId) : ""}
                  className={SELECT}
                >
                  <option value="">None</option>
                  {supplements.map((supplement) => (
                    <option key={supplement.id} value={supplement.id}>
                      {supplement.name}
                      {supplement.active ? "" : " · archived"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Meal">
                <select name="meal" defaultValue={link?.meal ?? "snack"} className={SELECT}>
                  {MEALS.map((meal) => (
                    <option key={meal.value} value={meal.value}>
                      {meal.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Grams" hint="One scoop is 32.4 g by default.">
              <Input
                name="grams"
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0.1"
                max="5000"
                defaultValue={link?.grams ?? 32.4}
                required
              />
            </Field>
            <div className="flex justify-end">
              <SubmitButton size="sm">Save</SubmitButton>
            </div>
          </ActionForm>
        )}
      </details>

      {link ? (
        <ActionForm
          action={saveWheyLinkAction}
          confirm="Remove the one-tap whey link? Past meals and supplement logs stay intact."
          confirmTitle="Remove whey link?"
          confirmLabel="Remove link"
          className="flex justify-end"
        >
          <input type="hidden" name="clear" value="1" />
          <SubmitButton size="xs" variant="ghost">
            Remove link
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}
