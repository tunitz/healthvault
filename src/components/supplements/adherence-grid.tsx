"use client";

import { useState } from "react";
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

function DayDot({ day, label }: { day: AdherenceWeek["days"][number]; label: string }) {
  const state = !day.scheduled
    ? "unscheduled"
    : day.taken
      ? "taken"
      : day.future
        ? "future"
        : "missed";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "block size-6 rounded-full border",
        state === "taken" && "border-primary bg-primary",
        state === "missed" && "border-destructive/50 bg-destructive/10",
        state === "future" && "border-muted-foreground/25",
        state === "unscheduled" && "border-dashed border-border bg-transparent",
      )}
    />
  );
}

export function AdherenceGrid({ items }: { items: SupplementAdherence[] }) {
  const [showArchived, setShowArchived] = useState(false);
  const visible = showArchived ? items : items.filter((item) => item.active);

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No supplements to track yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Sunday-start weeks. Scheduled days come from each regimen.
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
    </div>
  );
}
