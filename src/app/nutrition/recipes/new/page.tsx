import type { Metadata } from "next";
import Link from "next/link";
import { listFoods } from "@/lib/services/nutrition";
import { measureDefaults } from "@/lib/services/measures";
import { recipeFoodOption } from "@/lib/recipes-ui";
import { Card, CardContent } from "@/components/ui/card";
import { RecipeEditor } from "@/components/nutrition/recipe-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New recipe" };

export default function NewRecipePage() {
  const foods = listFoods({ limit: 100 }).items.map(recipeFoodOption);
  const defaults = measureDefaults();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/nutrition/recipes"
          className="inline-flex min-h-11 w-fit items-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground sm:min-h-0"
        >
          Recipes
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New recipe</h1>
        <p className="text-sm text-muted-foreground">
          Totals are computed on the server from each ingredient. Name-only ingredients stay
          incomplete instead of counting as zero.
        </p>
      </div>

      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <RecipeEditor initialFoods={foods} defaultMeasures={defaults} cancelHref="/nutrition/recipes" />
        </CardContent>
      </Card>
    </div>
  );
}
