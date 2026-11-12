import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentDay } from "@/lib/services/context";
import { getRecipe, type RecipeDetail } from "@/lib/services/recipes";
import { getTimezone } from "@/lib/services/profile";
import { ValidationError } from "@/lib/validate";
import { localClockNow } from "@/lib/day";
import { num, plural } from "@/lib/format";
import { nextServingNo } from "@/lib/recipes-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DeleteRecipeForm,
  RecipeLogForm,
  type LogIngredient,
} from "@/components/nutrition/recipe-forms";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id: rawId } = await props.params;
  const id = readId(rawId);
  if (id === null) return { title: "Recipe" };
  try {
    return { title: getRecipe(id).name };
  } catch {
    // A missing recipe renders the not-found page, which has its own title.
    return { title: "Recipe" };
  }
}

const STATE_LABEL: Record<string, string> = {
  raw: "raw",
  cooked: "cooked",
  dry: "dry",
  rehydrated: "rehydrated",
  none: "as sold",
};

function readId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function mealForClock(clock: string): "breakfast" | "lunch" | "dinner" | "snack" {
  const hour = Number(clock.slice(0, 2));
  if (!Number.isFinite(hour)) return "dinner";
  if (hour < 11) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}

function macroText(macros: {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
}): string {
  return `${num(macros.kcal, 0)} kcal · ${num(macros.proteinG, 1)} g protein · ${num(macros.carbsG, 1)} g carbs · ${num(macros.fatG, 1)} g fat · ${num(macros.fibreG, 1)} g fibre · ${num(macros.sodiumMg, 0)} mg sodium`;
}

export default async function RecipeDetailPage(props: { params: Promise<{ id: string }> }) {
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

  const timezone = getTimezone();
  const today = currentDay();
  const resolvedCount = recipe.ingredients.filter((ingredient) => ingredient.resolved).length;
  const hasResolved = resolvedCount > 0;
  const nextServing = nextServingNo(recipe.loggedServings, recipe.servingsTotal);

  const logIngredients: LogIngredient[] = recipe.ingredients.map((ingredient) => {
    const divisor = recipe.servingsTotal > 0 ? recipe.servingsTotal : 1;
    return {
      id: ingredient.id,
      name: ingredient.name ?? `ingredient ${ingredient.id}`,
      resolved: ingredient.resolved,
      grams: ingredient.grams,
      measure: ingredient.measure,
      state: ingredient.state,
      yieldFactor: ingredient.yieldFactor,
      perServingGrams: ingredient.grams / divisor,
    };
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Link
          href="/nutrition/recipes"
          className="inline-flex min-h-11 w-fit items-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground sm:min-h-0"
        >
          Recipes
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="min-w-0 break-words">{recipe.name}</span>
              {recipe.archived ? <Badge variant="secondary">archived</Badge> : null}
              {!recipe.complete ? <Badge variant="outline">incomplete</Badge> : null}
            </h1>
            <p className="text-sm text-muted-foreground">
              {plural(recipe.servingsTotal, "serving")} · {plural(resolvedCount, "resolved ingredient")}
              {recipe.remainingServings > 0
                ? ` · ${plural(recipe.remainingServings, "serving")} not logged`
                : " · all servings logged"}
            </p>
          </div>
          {!recipe.archived ? (
            <div className="flex items-center gap-1">
              <Button asChild variant="outline" size="sm">
                <Link href={`/nutrition/recipes/${recipe.id}/edit`}>Edit</Link>
              </Button>
              <DeleteRecipeForm
                key={recipe.id}
                id={recipe.id}
                name={recipe.name}
                returnTo="/nutrition/recipes"
              />
            </div>
          ) : null}
        </div>
        {recipe.note ? <p className="max-w-2xl break-words text-sm text-muted-foreground">{recipe.note}</p> : null}
      </div>

      {recipe.archived ? (
        <div role="status" className="rounded-xl border border-border p-4 text-sm">
          <p className="font-medium">Archived — logged meals stay intact.</p>
          <p className="mt-1 text-muted-foreground">
            This recipe leaves the active list and cannot be edited or logged again; its logged
            servings keep their own ingredient snapshots.
          </p>
        </div>
      ) : null}

      {!recipe.complete ? (
        <div
          role="status"
          className="rounded-xl border border-warning/40 bg-warning/15 p-4 text-sm"
        >
          <p className="font-medium">
            Incomplete — nutrition unknown for {plural(recipe.unresolvedIngredients.length, "ingredient")}.
          </p>
          <p className="mt-1 text-muted-foreground">
            {recipe.unresolvedIngredients.join(", ")}. Their grams are kept, but they contribute no
            nutrition to the totals below.
          </p>
          {resolvedCount === 0 ? (
            <p className="mt-1 text-muted-foreground">
              This recipe has no food-resolved ingredient, so it cannot be logged until one is
              linked to a saved food.
            </p>
          ) : null}
        </div>
      ) : null}

      <section aria-label="Recipe totals" className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Current recipe definition · logged servings keep their own ingredient snapshots.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base" role="heading" aria-level={2}>Per serving</CardTitle>
              <CardDescription>
                {recipe.complete ? "All ingredients resolved" : "Macros from resolved ingredients only"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {hasResolved ? (
                <>
                  <p className="num text-xl font-semibold">{num(recipe.perServing.macros.kcal, 0)} kcal</p>
                  <p className="num text-sm text-muted-foreground">
                    {num(recipe.perServing.macros.proteinG, 1)} g protein ·{" "}
                    {num(recipe.perServing.macros.carbsG, 1)} g carbs ·{" "}
                    {num(recipe.perServing.macros.fatG, 1)} g fat
                  </p>
                  <p className="num text-xs text-muted-foreground">
                    {num(recipe.perServing.grams)} g · fibre {num(recipe.perServing.macros.fibreG, 1)} g ·
                    sodium {num(recipe.perServing.macros.sodiumMg, 0)} mg
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">Nutrition unknown</p>
                  <p className="num text-xs text-muted-foreground">
                    {num(recipe.perServing.grams)} g per serving · no resolved ingredient yet
                  </p>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base" role="heading" aria-level={2}>Whole batch</CardTitle>
              <CardDescription>
                {recipe.complete ? "All ingredients resolved" : "Macros from resolved ingredients only"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {hasResolved ? (
                <>
                  <p className="num text-xl font-semibold">{num(recipe.total.macros.kcal, 0)} kcal</p>
                  <p className="num text-sm text-muted-foreground">{macroText(recipe.total.macros)}</p>
                </>
              ) : (
                <p className="text-sm font-medium">Nutrition unknown</p>
              )}
              <p className="num text-xs text-muted-foreground">{num(recipe.total.grams)} g</p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section aria-label="Ingredients" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Ingredients</h2>
          <span className="text-xs text-muted-foreground">
            {plural(recipe.ingredients.length, "ingredient")} · batch amounts
          </span>
        </div>
        <ul className="divide-y divide-border/60 rounded-xl border border-border">
          {recipe.ingredients.map((ingredient) => (
            <li key={ingredient.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="min-w-0 break-words font-medium" title={ingredient.name ?? undefined}>
                    {ingredient.name ?? `ingredient ${ingredient.id}`}
                  </span>
                  {ingredient.brand ? (
                    <span className="text-xs text-muted-foreground">{ingredient.brand}</span>
                  ) : null}
                  {ingredient.resolved ? (
                    ingredient.source ? (
                      <Badge variant="outline">{ingredient.source}</Badge>
                    ) : null
                  ) : (
                    <Badge variant="outline">unresolved</Badge>
                  )}
                </p>
                <p className="num text-xs text-muted-foreground">
                  {num(ingredient.grams)} g
                  {ingredient.measure
                    ? ` · recipe measure ${num(ingredient.measure.count)} × ${ingredient.measure.name}`
                    : ""}
                  {ingredient.state ? ` · ${STATE_LABEL[ingredient.state] ?? ingredient.state} basis` : ""}
                  {ingredient.yieldFactor !== null && ingredient.yieldFactor !== 1
                    ? ` · yield ${num(ingredient.yieldFactor)}`
                    : ""}
                  {" · "}
                  {num(ingredient.grams / (recipe.servingsTotal || 1))} g per serving
                </p>
              </div>
              <p className="num shrink-0 break-words text-xs text-muted-foreground sm:max-w-[28rem] sm:text-right">
                {ingredient.resolved
                  ? macroText(ingredient.macros)
                  : "Nutrition unknown — unresolved ingredient"}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Logged servings" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Logged servings</h2>
        {recipe.loggedServings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not logged yet.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border text-sm">
            {recipe.loggedServings.map((serving, index) => (
              <li key={`${serving.day}-${serving.meal}-${serving.servingNo ?? index}`} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  <span className="font-medium">{serving.day}</span>{" "}
                  <span className="text-muted-foreground">
                    · {serving.meal}
                    {serving.servingNo !== null ? ` · serving ${serving.servingNo}` : ""}
                    {serving.servingFraction !== null && serving.servingFraction !== 1
                      ? ` · ${num(serving.servingFraction)} portion`
                      : ""}
                  </span>
                </span>
                <Link
                  className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 sm:min-h-0"
                  href={`/nutrition?day=${serving.day}`}
                >
                  Day totals
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!recipe.archived && resolvedCount > 0 ? (
        <Card id="log" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-base" role="heading" aria-level={2}>
              {nextServing === null ? "Servings logged" : "Log a serving"}
            </CardTitle>
            <CardDescription>
              {nextServing === null
                ? "Every serving has a logged ingredient snapshot; the recipe definition is unchanged."
                : "One-time amounts apply to this meal only. The saved recipe is never changed, and the entry keeps its own ingredient snapshot."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecipeLogForm
              key={recipe.id}
              recipeId={recipe.id}
              servingsTotal={recipe.servingsTotal}
              ingredients={logIngredients}
              initialServingNo={nextServing}
              today={today}
              defaultMeal={mealForClock(localClockNow(timezone))}
              timezone={timezone}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
