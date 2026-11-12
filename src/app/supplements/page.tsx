import type { Metadata } from "next";
import { dayHeading } from "@/lib/day";
import { currentDay } from "@/lib/services/context";
import { getFood, searchFoods } from "@/lib/services/nutrition";
import { getProfile, parseWheyLink } from "@/lib/services/profile";
import { hasWheyAction } from "@/lib/services/whey";
import {
  listSupplements,
  parseSchedule,
  supplementHistory,
  todayChecklist,
  weeklyAdherence,
} from "@/lib/services/supplements";
import { num } from "@/lib/format";
import { SupplementChecklist, SupplementEditor } from "@/components/supplements/supplement-forms";
import { AdherenceGrid } from "@/components/supplements/adherence-grid";
import { ReminderBell } from "@/components/supplements/reminder-bell";
import { WheyLogButtons, WheySetupForm } from "@/components/supplements/whey-forms";

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
  const adherence = weeklyAdherence(4);
  const link = parseWheyLink(getProfile());
  const canUndoWhey = hasWheyAction(day);

  const foods = searchFoods("", 100).map((food) => ({
    id: food.id,
    name: food.name,
    brand: food.brand,
    kcalPer100g: food.kcalPer100g,
  }));
  // The linked food may be older than the 100 most recently updated; keep it selectable.
  if (link && !foods.some((food) => food.id === link.foodId)) {
    try {
      const food = getFood(link.foodId);
      foods.unshift({ id: food.id, name: food.name, brand: food.brand, kcalPer100g: food.kcalPer100g });
    } catch {
      // The link outlived its food; the service reports that clearly when logging.
    }
  }
  const linkedFood = link ? foods.find((food) => food.id === link.foodId) ?? null : null;
  const linkedSupplement = link?.supplementId
    ? all.find((supplement) => supplement.id === link.supplementId) ?? null
    : null;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Supplements</h1>
          <p className="text-sm text-muted-foreground">
            {dayHeading(day)} · {num(checklist.taken, 0)} of {num(checklist.total, 0)} taken
          </p>
        </div>
        <ReminderBell />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Today</h2>
        <SupplementChecklist day={day} items={checklist.items} />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">One-tap whey</h2>
          <p className="text-xs text-muted-foreground">
            {link
              ? `${linkedFood?.name ?? "Saved food no longer available"} · ${num(link.grams)} g · ${link.meal}${
                  linkedSupplement ? ` · ${linkedSupplement.name}` : ""
                }`
              : "Not configured."}
          </p>
        </div>
        <WheyLogButtons configured={link !== null} canUndo={canUndoWhey} />
        <WheySetupForm
          foods={foods}
          supplements={all.map((supplement) => ({
            id: supplement.id,
            name: supplement.name,
            active: supplement.active === 1,
          }))}
          link={link}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Adherence</h2>
          <p className="text-xs text-muted-foreground">Last 4 weeks, per regimen.</p>
        </div>
        <AdherenceGrid items={adherence} />
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
