"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toggleSupplementAction } from "@/app/actions";
import { LogDialog } from "@/components/log-dialog";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AdherenceWeek, SupplementAdherence } from "@/lib/services/supplements";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayShort(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function weekdayIndex(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** The current week is judged only on days that have already happened. */
function weekPercent(week: AdherenceWeek, isCurrent: boolean): { value: number; taken: number; scheduled: number } {
  return isCurrent
    ? { value: week.elapsedPct, taken: week.elapsedTakenDays, scheduled: week.elapsedScheduledDays }
    : { value: week.pct, taken: week.takenDays, scheduled: week.scheduledDays };
}

function DayDot({
  supplementName,
  day,
  label,
  onSelect,
}: {
  supplementName: string;
  day: AdherenceWeek["days"][number];
  label: string;
  onSelect: () => void;
}) {
  const state = !day.scheduled
    ? "unscheduled"
    : day.taken
      ? "taken"
      : day.future
        ? "future"
        : "missed";

  if (day.future) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className="block size-6 rounded-full border border-muted-foreground/25"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={day.taken}
      aria-label={`${supplementName} ${label} — click to change`}
      title={`${label} (click to change)`}
      className={cn(
        "flex size-7 items-center justify-center rounded-full border transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        state === "taken" && "border-primary bg-primary",
        state === "missed" && "border-destructive/50 bg-destructive/10",
        state === "unscheduled" && "border-dashed border-border bg-transparent",
      )}
    />
  );
}

type Selection = {
  supplementId: number;
  supplementName: string;
  day: string;
  taken: boolean;
  label: string;
};

export function AdherenceGrid({ items }: { items: SupplementAdherence[] }) {
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pending, startTransition] = useTransition();
  const visible = showArchived ? items : items.filter((item) => item.active);

  function applySelection() {
    if (!selection) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("supplementId", String(selection.supplementId));
      fd.set("day", selection.day);
      fd.set("taken", selection.taken ? "1" : "0");
      const result = await toggleSupplementAction({ ok: true }, fd);
      if (!result.ok) {
        toast.error(result.error ?? "Could not update intake");
        return;
      }
      toast.success(selection.taken ? "Marked as taken" : "Marked as not taken");
      setSelection(null);
      router.refresh();
    });
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No supplements to track yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Sunday-start weeks. Click any past or current day dot to change intake.
        </p>
        <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="size-4 accent-[var(--primary)]"
          />
          Show archived
        </label>
      </div>

      {/* Filled = taken, tinted = missed, outline = scheduled later, dashed = not scheduled. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-full border border-primary bg-primary" />
          taken
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-full border border-destructive/50 bg-destructive/10" />
          missed
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-full border border-muted-foreground/25" />
          scheduled later
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-full border border-dashed border-border" />
          not scheduled
        </li>
      </ul>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active supplements. Show archived to see past regimens.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {visible.map((item) => {
            const currentIndex = item.weeks.length - 1;
            const current = item.weeks[currentIndex];
            const currentPercent = weekPercent(current, true);
            return (
              <li key={item.supplementId} className="flex flex-col gap-3 rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="num text-xs text-muted-foreground">
                      {num(item.dose)} {item.unit}
                      {item.active ? "" : " · archived"}
                    </p>
                  </div>
                  <p className="num text-xs text-muted-foreground">
                    {currentPercent.scheduled > 0
                      ? `${currentPercent.taken}/${currentPercent.scheduled} this week`
                      : "not scheduled this week"}
                  </p>
                </div>

                <div className="grid grid-cols-7 gap-1">
                  {current.days.map((day) => (
                    <div key={day.day} className="flex min-w-0 flex-col items-center gap-1">
                      <span aria-hidden className="text-[11px] uppercase text-muted-foreground">
                        {WEEKDAYS[weekdayIndex(day.day)].slice(0, 2)}
                      </span>
                      <DayDot
                        supplementName={item.name}
                        day={day}
                        label={`${weekdayShort(day.day)} ${day.day.slice(5)}: ${
                          !day.scheduled
                            ? "not scheduled"
                            : day.taken
                              ? "taken"
                              : day.future
                                ? "scheduled later"
                                : "not taken"
                        }`}
                        onSelect={() =>
                          setSelection({
                            supplementId: item.supplementId,
                            supplementName: item.name,
                            day: day.day,
                            taken: !day.taken,
                            label: `${weekdayShort(day.day)} ${day.day.slice(5)}`,
                          })
                        }
                      />
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 text-xs">
                  {item.weeks.map((week, index) => {
                    const isCurrent = index === currentIndex;
                    const percent = weekPercent(week, isCurrent);
                    return (
                      <span key={week.weekStart} className="flex items-baseline gap-1.5">
                        <span className="text-muted-foreground">
                          {isCurrent ? "Now" : `Wk ${week.weekStart.slice(5)}`}
                        </span>
                        <span className="num font-medium">{percent.scheduled > 0 ? `${percent.value}%` : "—"}</span>
                      </span>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <LogDialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
        title={selection ? `Update ${selection.supplementName}` : "Update intake"}
        description={selection ? `${selection.label} · ${selection.taken ? "mark as taken" : "mark as not taken"}` : undefined}
        size="sm"
        footer={
          <>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={applySelection} disabled={pending} aria-busy={pending}>
              Save
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {selection
            ? `Record ${selection.supplementName} as ${selection.taken ? "taken" : "not taken"} on ${selection.label}?`
            : ""}
        </p>
      </LogDialog>
    </div>
  );
}
