"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowRight, Search } from "lucide-react";
import { toast } from "sonner";
import { applyCorrectionsAction, previewCorrectionsAction } from "@/app/actions";
import { Field, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  CorrectionApplyState,
  CorrectionPreviewState,
} from "@/lib/action-state";
import {
  changeSummary,
  groupChanges,
  isStalePreviewError,
  macroDeltas,
  nothingToApply,
  scopeDescription,
  scopeTooLarge,
  skipReasonLabel,
} from "@/lib/corrections-ui";
import { dayHeading } from "@/lib/day";
import { num, plural } from "@/lib/format";
import type { HistoryChange, HistoryPreview } from "@/lib/services/food-history";

const MEAL_LABEL: Record<string, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

const SELECT =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-8 md:text-sm dark:bg-input/30";

export type CorrectionFood = { id: number; name: string; brand: string | null };

function ChangeRow({ change }: { change: HistoryChange }) {
  const deltas = macroDeltas(change.previous, change.proposed);
  const skipped = change.status === "skipped";
  const unchanged = change.status === "unchanged";

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <span className="min-w-0 truncate" title={change.name}>
            {change.name}
          </span>
          {change.kind === "ingredient" ? <Badge variant="outline">ingredient</Badge> : null}
          {skipped ? (
            <Badge variant="destructive">skipped</Badge>
          ) : unchanged ? (
            <Badge variant="outline">already up to date</Badge>
          ) : null}
        </p>
        <span className="num shrink-0 text-xs text-muted-foreground">
          {change.previous ? `${num(change.previous.grams)} g` : "—"}
        </span>
      </div>

      {skipped ? (
        <p className="text-xs text-muted-foreground">{skipReasonLabel(change.reason)}</p>
      ) : deltas.length === 0 ? (
        <p className="text-xs text-muted-foreground">No nutrition change.</p>
      ) : (
        <dl className="grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {deltas.map((delta) => (
            <div key={delta.label} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
              <dt className="text-muted-foreground">{delta.label}</dt>
              <dd className="num shrink-0">
                <span className="text-muted-foreground">
                  {num(delta.from, delta.digits)}
                  {delta.unit ? ` ${delta.unit}` : ""}
                </span>
                <span aria-hidden className="mx-1 text-muted-foreground">
                  →
                </span>
                <span className="sr-only">changed to</span>
                <span className="font-medium">
                  {num(delta.to, delta.digits)}
                  {delta.unit ? ` ${delta.unit}` : ""}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function PreviewResults({
  preview,
  foodName,
  onApplyState,
  onPreviewAgain,
  previewing,
}: {
  preview: HistoryPreview;
  foodName: string | null;
  onApplyState: (state: CorrectionApplyState) => void;
  onPreviewAgain: () => void;
  previewing: boolean;
}) {
  const groups = useMemo(() => groupChanges(preview.changes), [preview.changes]);
  const empty = nothingToApply(preview);

  return (
    <section aria-label="Preview results" className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Preview</h2>
        <span className="text-xs text-muted-foreground">Read-only · writes nothing</span>
      </div>

      <p className="text-sm" aria-live="polite">{changeSummary(preview)}</p>
      <p className="text-xs text-muted-foreground">Scope: {scopeDescription(preview.scope, foodName)}</p>

      {Object.keys(preview.skippedReasons).length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/15 px-3 py-2 text-xs">
          {Object.entries(preview.skippedReasons).map(([reason, count]) => (
            <li key={reason}>
              {plural(count, "row")} skipped — {skipReasonLabel(reason)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex max-h-[32rem] flex-col gap-4 overflow-y-auto">
        {groups.map((group) => (
          <div key={`${group.day}-${group.meal}`} className="min-w-0">
            <h3 className="text-xs font-medium text-muted-foreground">
              {dayHeading(group.day)} · {MEAL_LABEL[group.meal] ?? group.meal}
            </h3>
            <ul className="mt-1 divide-y divide-border/60">
              {group.changes.map((change) => (
                <ChangeRow key={`${change.kind}-${change.entryId}-${change.ingredientId ?? 0}`} change={change} />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {empty ? (
        <p role="status" className="rounded-lg border border-border px-3 py-2 text-sm">
          Every affected snapshot is already up to date. Nothing to apply.
        </p>
      ) : (
        <ApplyForm
          preview={preview}
          foodName={foodName}
          onState={onApplyState}
          onPreviewAgain={onPreviewAgain}
          previewing={previewing}
        />
      )}
    </section>
  );
}

function ApplyForm({
  preview,
  foodName,
  onState,
  onPreviewAgain,
  previewing,
}: {
  preview: HistoryPreview;
  foodName: string | null;
  onState: (state: CorrectionApplyState) => void;
  onPreviewAgain: () => void;
  previewing: boolean;
}) {
  const [state, formAction] = useActionState<CorrectionApplyState, FormData>(
    applyCorrectionsAction,
    { ok: true },
  );

  useEffect(() => {
    if (state.ok && state.message) toast.success("Past meals corrected", { description: state.message });
    if (state.stale) {
      toast.error("Preview expired or data changed", {
        description: "Run Preview again to see the current change set.",
      });
    }
    // Report only meaningful outcomes upward; the initial idle state must not churn the parent.
    if (state.applied !== undefined || state.stale || state.error) onState(state);
  }, [state, onState]);

  const scope = scopeDescription(preview.scope, foodName);

  // Once a change set is applied the same hash can never be replayed (the service would reject it
  // as stale), so the form is replaced by the result instead of inviting a second click.
  if (state.ok && state.applied !== undefined) {
    return (
      <div role="status" className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">{state.message}</p>
        <p className="text-xs text-muted-foreground">
          Corrections apply only to what the preview listed. Logged meals on other days, and the
          saved food itself, are unchanged.
        </p>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onPreviewAgain} disabled={previewing}>
            <Search aria-hidden />
            {previewing ? "Reading snapshots…" : "Preview again"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <input type="hidden" name="previewHash" value={preview.previewHash} />
      {preview.scope.foodIds.map((id) => (
        <input key={`food-${id}`} type="hidden" name="foodIds" value={id} />
      ))}
      {preview.scope.entryIds.map((id) => (
        <input key={`entry-${id}`} type="hidden" name="entryIds" value={id} />
      ))}
      {preview.scope.fromDay ? (
        <input type="hidden" name="fromDay" value={preview.scope.fromDay} />
      ) : null}
      {preview.scope.toDay ? <input type="hidden" name="toDay" value={preview.scope.toDay} /> : null}

      <label className="flex min-h-11 items-start gap-2 text-xs sm:min-h-0">
        <input
          type="checkbox"
          name="confirmScope"
          required
          className="mt-0.5 size-4 accent-[var(--primary)]"
        />
        <span>
          <span className="block font-medium text-foreground">
            Apply {plural(preview.changed, "correction")} to {scope}
          </span>
          <span className="text-muted-foreground">
            Only the rows listed above change. Every changed row keeps a revision with its previous
            values.
          </span>
        </span>
      </label>

      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
          {state.stale ? " Run Preview again." : ""}
        </p>
      ) : null}

      <div className="flex items-center justify-end">
        <SubmitButton size="sm" pendingLabel="Applying…">
          <ArrowRight aria-hidden />
          Apply corrections
        </SubmitButton>
      </div>
    </form>
  );
}

export function CorrectionsPanel({
  foods,
  initialFood,
  requestedFoodId,
  maxRows,
}: {
  foods: CorrectionFood[];
  /** The `?foodId=` carried in from a food edit; null when absent or no longer present. */
  initialFood: CorrectionFood | null;
  /** The raw `?foodId=` value, so a deleted food is reported rather than silently ignored. */
  requestedFoodId: number | null;
  maxRows: number;
}) {
  const [foodIds, setFoodIds] = useState<string[]>(
    initialFood === null ? [] : [String(initialFood.id)],
  );
  const [entryIds, setEntryIds] = useState("");
  const [preview, setPreview] = useState<CorrectionPreviewState | null>(null);
  const [applyState, setApplyState] = useState<CorrectionApplyState | null>(null);
  const [runKey, setRunKey] = useState(0);
  const [previewing, startPreview] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // A stale apply means the change set moved under the preview. The preview on screen is no
  // longer valid: it is treated as expired (never re-applied) and the user re-runs Preview.
  const stale = applyState?.stale === true;

  const selectedFood = foods.find((food) => String(food.id) === foodIds[0]) ?? null;

  function runPreview() {
    if (emptyScope) {
      setPreview({ ok: false, error: "Choose a food or enter entry ids to scope the preview." });
      return;
    }
    const fd = new FormData();
    for (const id of foodIds) fd.append("foodIds", id);
    if (entryIds.trim() !== "") fd.append("entryIds", entryIds);
    const form = formRef.current;
    if (form) {
      const from = form.elements.namedItem("fromDay");
      const to = form.elements.namedItem("toDay");
      if (from instanceof HTMLInputElement && from.value) fd.append("fromDay", from.value);
      if (to instanceof HTMLInputElement && to.value) fd.append("toDay", to.value);
    }

    // A Server Action invoked from an event handler runs inside a transition (as elsewhere in
    // this app), so the pending state comes from React rather than a hand-rolled flag.
    setApplyState(null);
    startPreview(async () => {
      try {
        const result = await previewCorrectionsAction(fd);
        setPreview(result);
        setRunKey((value) => value + 1);
        if (!result.ok) toast.error("Preview failed", { description: result.error });
      } catch {
        setPreview({ ok: false, error: "Preview failed — try again" });
      }
    });
  }

  const emptyScope = foodIds.length === 0 && entryIds.trim() === "";

  return (
    <div className="flex flex-col gap-6">
      <form
        ref={formRef}
        className="flex flex-col gap-4 rounded-xl border border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          runPreview();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Saved food</legend>
          <Field label="Food" hint={`Pick the food whose values changed. Up to ${maxRows} snapshots per apply.`}>
            <select
              value={foodIds[0] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setFoodIds(value === "" ? [] : [value]);
                setPreview(null);
                setApplyState(null);
              }}
              className={SELECT}
            >
              <option value="">Choose a food</option>
              {foods.map((food) => (
                <option key={food.id} value={food.id}>
                  {food.name}
                  {food.brand ? ` · ${food.brand}` : ""}
                </option>
              ))}
            </select>
          </Field>
          {requestedFoodId !== null && initialFood === null ? (
            <p role="status" className="text-xs text-destructive">
              Food #{requestedFoodId} is not in the saved list. Choose a food below, or enter the
              logged entry ids instead.
            </p>
          ) : null}
        </fieldset>

        <Field
          label="Entry ids"
          hint="Optional. Comma-separated; combined with the food and date range above."
        >
          <Input
            value={entryIds}
            onChange={(event) => {
              setEntryIds(event.target.value);
              setPreview(null);
              setApplyState(null);
            }}
            placeholder="e.g. 42, 57"
            inputMode="numeric"
            name="entryIds"
            className="max-sm:h-11"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From day" hint="Optional · inclusive">
            <Input
              type="date"
              name="fromDay"
              className="max-sm:h-11"
              onChange={() => {
                // A range edit invalidates the change set on screen; never apply an unseen scope.
                setPreview(null);
                setApplyState(null);
              }}
            />
          </Field>
          <Field label="To day" hint="Optional · inclusive">
            <Input
              type="date"
              name="toDay"
              className="max-sm:h-11"
              onChange={() => {
                setPreview(null);
                setApplyState(null);
              }}
            />
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">
          Saving a food never rewrites past meals. This screen is the explicit correction: it
          previews first, and applying needs the scope confirmed with the preview you saw.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="outline" size="sm" disabled={emptyScope || previewing}>
            <Search aria-hidden />
            {previewing ? "Reading snapshots…" : "Preview"}
          </Button>
          {preview ? <span className="text-xs text-muted-foreground">Preview below</span> : null}
        </div>
        {emptyScope ? (
          <p className="text-xs text-muted-foreground">
            Choose a food or enter entry ids to scope the preview.
          </p>
        ) : null}
      </form>

      {stale ? (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-destructive/40 p-4 text-sm">
          <p className="font-medium">Preview expired or data changed</p>
          <p className="text-muted-foreground">
            Nothing was applied. Run Preview again to see the current change set, then confirm it.
          </p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
              <Search aria-hidden />
              {previewing ? "Reading snapshots…" : "Preview again"}
            </Button>
          </div>
        </div>
      ) : preview === null ? (
        <p className="text-sm text-muted-foreground">
          Preview shows every affected snapshot and writes nothing.
        </p>
      ) : preview.ok ? (
        <PreviewResults
          key={runKey}
          preview={preview.preview}
          foodName={selectedFood?.name ?? null}
          onApplyState={setApplyState}
          onPreviewAgain={runPreview}
          previewing={previewing}
        />
      ) : (
        <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
          <p className="font-medium">Preview could not be built</p>
          <p className="mt-1 text-muted-foreground">
            {preview.error}
            {scopeTooLarge(preview.error) ? " Narrow the date range, or scope by entry id." : ""}
            {isStalePreviewError(preview.error) ? " Run Preview again." : ""}
          </p>
        </div>
      )}
    </div>
  );
}
