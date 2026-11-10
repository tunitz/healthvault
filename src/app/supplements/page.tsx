import type { Metadata } from "next";
import { dayHeading } from "@/lib/day";
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

export const metadata: Metadata = { title: "Supplements" };

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
          {dayHeading(day)} · {num(checklist.taken, 0)} of {num(checklist.total, 0)} taken
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Today</h2>
        <SupplementChecklist day={day} items={checklist.items} />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Regimen</h2>
          <p className="text-xs text-muted-foreground">Archiving keeps history.</p>
        </div>
        <SupplementEditor items={editorItems} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Last 30 days</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No intake logged in the last 30 days.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {history.map((entry) => (
              <li
                key={entry.day}
                className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[auto_1fr_auto] sm:items-baseline sm:gap-4"
              >
                <p className="num text-sm">{entry.day}</p>
                <p className="col-span-2 min-w-0 break-words text-xs text-muted-foreground sm:col-span-1">
                  {entry.items
                    .map((item) => `${item.name} ${num(item.dose)} ${item.unit}`)
                    .join(" · ")}
                </p>
                <p className="num col-start-2 row-start-1 text-right text-xs text-muted-foreground sm:col-start-auto sm:row-start-auto">
                  {entry.taken} taken
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
