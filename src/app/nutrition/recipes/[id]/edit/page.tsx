import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRecipe, type RecipeDetail } from "@/lib/services/recipes";
import { getFood, listFoods } from "@/lib/services/nutrition";
import { effectiveMeasures, measureDefaults } from "@/lib/services/measures";
import { ValidationError } from "@/lib/validate";
import {
  editorRowsFromRecipe,
  recipeFoodOption,
  type RecipeFoodOption,
} from "@/lib/recipes-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RecipeEditor } from "@/components/nutrition/recipe-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edit recipe" };

function readId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default async function EditRecipePage(props: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await props.params;
  const id = readId(rawId);
  if (id === null) notFound();

  let recipe: RecipeDetail;
  try {
    recipe = getRecipe(id);
  } catch (error) {
    if (error instanceof ValidationError && error.status === 404) notFound();
    throw error;
  }

  if (recipe.archived) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/nutrition/recipes"
            className="inline-flex min-h-11 w-fit items-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground sm:min-h-0"
          >
            Recipes
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{recipe.name}</h1>
        </div>
        <div role="status" className="flex max-w-2xl flex-col items-start gap-3 rounded-xl border border-border p-4">
          <p className="text-sm">
            This recipe is archived. Archived recipes are history and cannot be edited; logged
            meals keep their ingredient snapshots.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href={`/nutrition/recipes/${recipe.id}`}>Open recipe</Link>
          </Button>
        </div>
      </div>
    );
  }

  const defaults = measureDefaults();
  const byId = new Map<number, RecipeFoodOption>();
  for (const food of listFoods({ limit: 100 }).items) {
    byId.set(food.id, recipeFoodOption(food));
  }
  // A recipe may reference an older food outside the recent-100 window; load those explicitly
  // so the picker shows its name, basis and household measures.
  for (const ingredient of recipe.ingredients) {
    if (ingredient.foodId === null || byId.has(ingredient.foodId)) continue;
    try {
      const food = getFood(ingredient.foodId);
      byId.set(
        food.id,
        recipeFoodOption({ ...food, measures: effectiveMeasures(food.measuresJson, defaults) }),
      );
    } catch {
      // Dangling food reference: the stored name stays visible, and the ingredient is unresolved.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={`/nutrition/recipes/${recipe.id}`}
          className="inline-flex min-h-11 w-fit items-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground sm:min-h-0"
        >
          {recipe.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit recipe</h1>
        <p className="text-sm text-muted-foreground">
          Saving changes affects future servings only. Already-logged meals keep their snapshots.
        </p>
      </div>

      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <RecipeEditor
            key={recipe.id}
            recipe={{
              id: recipe.id,
              name: recipe.name,
              servingsTotal: recipe.servingsTotal,
              note: recipe.note,
              ingredients: editorRowsFromRecipe(recipe.ingredients),
            }}
            initialFoods={[...byId.values()]}
            defaultMeasures={defaults}
            cancelHref={`/nutrition/recipes/${recipe.id}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}
