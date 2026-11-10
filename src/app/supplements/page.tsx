import { dayLabel } from "@/lib/day";
import { currentDay } from "@/lib/services/context";
import {
  listSupplements,
  parseSchedule,
  supplementHistory,
  todayChecklist,
} from "@/lib/services/supplements";
import { num } from "@/lib/format";
import { SupplementChecklist, SupplementEditor } from "@/components/supplements/supplement-forms";

export const dynamic = "force-dynamic";

export default function SupplementsPage() {
  const day = currentDay();
  const checklist = todayChecklist(day);
  const all = listSupplements(false);
  const editorItems = all.map((supplement) => ({
    supplement,
    schedule: parseSchedule(supplement.scheduleJson),
  }));
  const history = supplementHistory(30);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Supplements</h1>
        <p className="text-sm text-muted-foreground">
          {dayLabel(day)} · {num(checklist.taken, 0)} of {num(checklist.total, 0)} taken
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Today</h2>
          <p className="text-xs text-muted-foreground">Tap a circle to mark it taken or undo it.</p>
        </div>
        <SupplementChecklist day={day} items={checklist.items} />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Regimen</h2>
          <p className="text-xs text-muted-foreground">Dose, schedule and notes. Archiving keeps history.</p>
        </div>
        <SupplementEditor items={editorItems} />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Last 30 days</h2>
          <p className="text-xs text-muted-foreground">Days with at least one logged dose.</p>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No intake logged in the last 30 days.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {history.map((entry) => (
              <li key={entry.day} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <p className="num shrink-0 text-sm">{entry.day}</p>
                <p className="min-w-0 text-xs text-muted-foreground">
                  {entry.items
                    .map((item) => `${item.name} ${num(item.dose)} ${item.unit}`)
                    .join(" · ")}
                </p>
                <p className="num shrink-0 text-xs text-muted-foreground">{entry.taken} taken</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
