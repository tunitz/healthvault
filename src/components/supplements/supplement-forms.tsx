"use client";

import { archiveSupplementAction, saveSupplementAction, toggleSupplementAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { num } from "@/lib/format";
import type { ChecklistItem, Supplement } from "@/lib/services/supplements";

const SELECT =
  "h-8 max-sm:h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";
/** 16 px on phones so iOS Safari does not zoom the page when the field is focused. */
const AREA =
  "min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Schedule = { time: string | null; days: number[] | null; note?: string };
type Item = { supplement: Supplement; schedule: Schedule };

export function SupplementChecklist({ day, items }: { day: string; items: ChecklistItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No supplement scheduled for today.</p>;
  }

  return (
    <ul className="divide-y divide-border/60">
      {items.map(({ supplement, schedule, logged }) => (
        <li key={supplement.id} className="flex items-center gap-3 py-2.5">
          <ActionForm action={toggleSupplementAction} className="flex flex-1 items-center gap-3">
            <input type="hidden" name="supplementId" value={supplement.id} />
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="taken" value={logged ? "0" : "1"} />
            <SubmitButton
              variant={logged ? "secondary" : "outline"}
              size="icon"
              pendingLabel=""
              aria-label={logged ? `Mark ${supplement.name} untaken` : `Mark ${supplement.name} taken`}
              className={cn("size-9 shrink-0 rounded-full max-sm:size-11", logged && "border-primary/40 text-primary")}
            >
              <span
                aria-hidden
                className={cn(
                  "block rounded-full",
                  logged ? "size-3 bg-current" : "size-3 border border-muted-foreground/50",
                )}
              />
            </SubmitButton>
            <div className="min-w-0">
              <p className={cn("truncate text-sm", logged && "text-muted-foreground line-through")}>
                {supplement.name}
              </p>
              <p className="num text-xs text-muted-foreground">
                {num(supplement.dose)} {supplement.unit}
                {schedule.time ? ` · ${schedule.time}` : ""}
              </p>
            </div>
          </ActionForm>
        </li>
      ))}
    </ul>
  );
}

function SupplementForm({ item }: { item?: Item }) {
  const schedule = item?.schedule;
  return (
    <ActionForm action={saveSupplementAction} className="grid gap-3 border-t border-border p-4">
      {item ? <input type="hidden" name="id" value={item.supplement.id} /> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" className="col-span-2">
          <Input name="name" defaultValue={item?.supplement.name ?? ""} required maxLength={160} placeholder="e.g. creatine" />
        </Field>
        <Field label="Dose">
          <Input name="dose" type="number" inputMode="decimal" step="0.01" min="0.01" defaultValue={item?.supplement.dose ?? 1} />
        </Field>
        <Field label="Unit">
          <Input name="unit" defaultValue={item?.supplement.unit ?? "capsule"} maxLength={40} />
        </Field>
        <p className="col-span-2 text-[11px] text-muted-foreground">
          doses as recorded — compound, not elemental, unless stated
        </p>
        <Field label="Time">
          <Input name="time" type="time" defaultValue={schedule?.time ?? ""} />
        </Field>
        <Field label="Active" hint="Uncheck to archive">
          <select name="active" defaultValue={item ? (item.supplement.active ? "1" : "0") : "1"} className={SELECT}>
            <option value="1">Active</option>
            <option value="0">Archived</option>
          </select>
        </Field>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-xs text-muted-foreground">Days</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {WEEKDAYS.map((label, weekday) => (
            <label key={weekday} className="flex min-h-11 items-center gap-1 text-xs sm:min-h-0">
              <input
                type="checkbox"
                name="days"
                value={weekday}
                defaultChecked={!schedule?.days || schedule.days.includes(weekday)}
                className="size-4 accent-[var(--primary)]"
              />
              {label}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">All boxes checked means every day.</p>
      </fieldset>

      <Field label="Notes">
        <textarea name="notes" className={AREA} defaultValue={item?.supplement.notes ?? ""} placeholder="Optional" />
      </Field>

      <div className="flex justify-end">
        <SubmitButton size="sm">{item ? "Save" : "Add supplement"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function SupplementEditor({ items }: { items: Item[] }) {
  return (
    <div className="flex flex-col gap-2">
      <details className="rounded-xl border border-border" open={items.length === 0}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Add supplement</summary>
        <SupplementForm />
      </details>

      {items.map((item) => (
        <details key={item.supplement.id} className="rounded-xl border border-border">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="min-w-0 truncate">{item.supplement.name}</span>
            <span className="num shrink-0 text-xs text-muted-foreground">
              {num(item.supplement.dose)} {item.supplement.unit}
              {!item.supplement.active ? " · archived" : ""}
            </span>
          </summary>
          {item.supplement.nutrientsJson ? (
            <div className="border-t border-border px-4 py-3">
              <p className="text-[11px] text-muted-foreground">
                doses as recorded — compound, not elemental, unless stated
              </p>
              <p className="mt-1 break-words font-mono text-xs">{item.supplement.nutrientsJson}</p>
            </div>
          ) : null}
          <SupplementForm item={item} />
          <div className="border-t border-border px-4 py-3">
            <ActionForm action={archiveSupplementAction} className="flex items-center justify-between gap-3">
              <input type="hidden" name="id" value={item.supplement.id} />
              <p className="text-xs text-muted-foreground">
                {item.supplement.active ? "Archiving keeps past intake." : "Already archived."}
              </p>
              <SubmitButton variant="ghost" size="xs">
                Archive
              </SubmitButton>
            </ActionForm>
          </div>
        </details>
      ))}
    </div>
  );
}
