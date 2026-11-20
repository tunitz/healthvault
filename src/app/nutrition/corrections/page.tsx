import type { Metadata } from "next";
import Link from "next/link";
import { getFood, listFoods } from "@/lib/services/nutrition";
import { MAX_HISTORY_REFRESH_ROWS } from "@/lib/services/food-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CorrectionsPanel, type CorrectionFood } from "@/components/nutrition/correction-forms";
import { NutritionNav } from "@/components/nutrition/nutrition-nav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Correct past meals" };

const FOOD_LIMIT = 100;

function readId(value: string | string[] | undefined): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function toOption(food: { id: number; name: string; brand: string | null }): CorrectionFood {
  return { id: food.id, name: food.name, brand: food.brand };
}

export default async function CorrectionsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const requestedFoodId = readId(params.foodId);
  // The service caps a search at 120 characters; a long URL must not turn the page into an error.
  const query = (typeof params.q === "string" ? params.q.trim() : "").slice(0, 120);

  // `listFoods` is bounded, so the picker is searchable rather than claiming to list every food.
  const page = listFoods({ query, limit: FOOD_LIMIT });
  const foods = new Map<number, CorrectionFood>(page.items.map((food) => [food.id, toOption(food)]));
  let requestedFood: CorrectionFood | null = null;
  if (requestedFoodId !== null) {
    requestedFood = foods.get(requestedFoodId) ?? null;
    if (requestedFood === null) {
      try {
        // A food linked from an edit may sit outside the current search page.
        requestedFood = toOption(getFood(requestedFoodId));
        foods.set(requestedFood.id, requestedFood);
      } catch {
        // Deleted or unknown: the panel asks the user to pick a food or use entry ids.
      }
    }
  }
  const foodNames = [...foods.values()];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Correct past meals</h1>
        <p className="text-sm text-muted-foreground">
          Preview a correction, then apply only the rows you reviewed. Saved-food or recipe edits
          never rewrite logged meals on their own.
        </p>
      </div>

      <NutritionNav />

      <form method="get" role="search" className="flex flex-wrap items-center gap-2">
        {requestedFoodId !== null ? (
          <input type="hidden" name="foodId" value={requestedFoodId} />
        ) : null}
        <Input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search saved foods"
          aria-label="Search saved foods"
          className="h-11 w-full min-w-0 flex-1 sm:h-8 sm:max-w-xs sm:flex-none"
        />
        {query ? (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="max-sm:size-11"
            aria-label="Clear search"
            title="Clear search"
          >
            <Link href={requestedFoodId ? `/nutrition/corrections?foodId=${requestedFoodId}` : "/nutrition/corrections"}>×</Link>
          </Button>
        ) : null}
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
        <span className="num text-xs text-muted-foreground">
          {page.total > foodNames.length ? `${foodNames.length} of ${page.total}` : `${page.total} foods`}
        </span>
      </form>

      {page.total === 0 && query === "" ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-border p-4 text-sm">
          <p className="text-muted-foreground">
            No saved foods yet, so there are no logged snapshots to correct.
          </p>
          <Link className="text-primary underline underline-offset-4" href="/nutrition/foods">
            Add a food
          </Link>
        </div>
      ) : foodNames.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No saved foods match “{query}”.{" "}
          <Link className="underline underline-offset-4" href="/nutrition/corrections">
            Clear search
          </Link>
        </p>
      ) : (
        <CorrectionsPanel
          foods={foodNames}
          initialFood={requestedFood}
          requestedFoodId={requestedFoodId}
          maxRows={MAX_HISTORY_REFRESH_ROWS}
        />
      )}

      <section aria-label="How corrections work" className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          Skipped rows are labelled with a reason: an entry without recorded ingredient details, an
          unknown or changed basis, a changed yield factor, or a food that no longer exists. Missing
          data is never guessed or filled with zeros.
        </p>
        <p>
          A preview that no longer matches the data is refused rather than applied. Scopes larger
          than {MAX_HISTORY_REFRESH_ROWS} snapshots are rejected — narrow the date range instead.
        </p>
      </section>
    </div>
  );
}
