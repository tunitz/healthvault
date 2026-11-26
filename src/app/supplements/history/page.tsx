import type { Metadata } from "next";
import { num } from "@/lib/format";
import { supplementHistory, weeklyAdherence } from "@/lib/services/supplements";
import { AdherenceGrid } from "@/components/supplements/adherence-grid";
import { SubviewHeader, SubviewNav } from "@/components/subviews/subview-header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Supplement history" };

const SECTIONS = [
  { href: "/supplements", label: "Today" },
  { href: "/supplements/regimens", label: "Regimens" },
  { href: "/supplements/history", label: "History" },
] as const;

export default function SupplementHistoryPage() {
  const history = supplementHistory(30);
  const adherence = weeklyAdherence(4);

  return (
    <div className="flex flex-col gap-8">
      <SubviewHeader
        title="History"
        description="Adherence by regimen and doses logged in the last 30 days."
        backHref="/supplements"
        backLabel="Today's checklist"
      >
        <SubviewNav label="Supplements sections" items={SECTIONS} activeHref="/supplements/history" />
      </SubviewHeader>

      <section className="flex flex-col gap-3" aria-labelledby="supplement-adherence">
        <div className="flex flex-col gap-0.5">
          <h2 id="supplement-adherence" className="text-sm font-medium">Adherence</h2>
          <p className="text-xs text-muted-foreground">Last 4 weeks, per regimen. Current week counts elapsed days only.</p>
        </div>
        <AdherenceGrid items={adherence} />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="supplement-log">
        <h2 id="supplement-log" className="text-sm font-medium">Last 30 days</h2>
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
                  {entry.items.map((item) => `${item.name} ${num(item.dose)} ${item.unit}`).join(" · ")}
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
