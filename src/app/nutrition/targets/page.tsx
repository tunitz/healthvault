import type { Metadata } from "next";
import { isDay } from "@/lib/day";
import { currentDay } from "@/lib/services/context";
import { resolveTargets } from "@/lib/services/nutrition";
import { getTimezone } from "@/lib/services/profile";
import { num } from "@/lib/format";
import { TargetsForm } from "@/components/nutrition/nutrition-forms";
import { SubviewHeader, SubviewNav } from "@/components/subviews/subview-header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Nutrition targets" };

const SECTIONS = [
  { href: "/nutrition", label: "Diary" },
  { href: "/nutrition/foods", label: "Foods" },
  { href: "/nutrition/recipes", label: "Recipes" },
  { href: "/nutrition/targets", label: "Targets" },
] as const;

export default async function NutritionTargetsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const today = currentDay();
  const day = typeof params.day === "string" && isDay(params.day) ? params.day : today;
  const timezone = getTimezone();
  const targets = resolveTargets(day);

  const values = [
    { label: "kcal", value: num(targets.kcal, 0) },
    { label: "Protein", value: `${num(targets.proteinG, 0)} g` },
    { label: "Carbs", value: `${num(targets.carbsG, 0)} g` },
    { label: "Fat", value: `${num(targets.fatG, 0)} g` },
    { label: "Fibre", value: `${num(targets.fibreG, 0)} g` },
    { label: "Sodium", value: `${num(targets.sodiumMg, 0)} mg` },
  ];

  return (
    <div className="flex flex-col gap-8">
      <SubviewHeader
        title="Targets"
        description={`Daily goals effective ${day} · ${timezone}`}
        backHref="/nutrition"
        backLabel="Nutrition diary"
      >
        <SubviewNav label="Nutrition sections" items={SECTIONS} activeHref="/nutrition/targets" />
      </SubviewHeader>

      <section className="flex flex-col gap-3" aria-labelledby="targets-current">
        <div className="flex flex-col gap-0.5">
          <h2 id="targets-current" className="text-sm font-medium">Current targets</h2>
          <p className="text-xs text-muted-foreground">
            {targets.source === "suggested"
              ? "Calculated from profile and latest weight."
              : `Manual targets from ${targets.effectiveFrom}.`}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {values.map((item) => (
            <div key={item.label} className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="num truncate text-lg font-semibold tracking-tight">{item.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Edit targets</h2>
          <p className="text-xs text-muted-foreground">
            Saving creates manual targets effective from {day}. Open Targets to change the values.
          </p>
        </div>
        <TargetsForm day={day} targets={targets} />
      </section>
    </div>
  );
}
