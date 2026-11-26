import type { Metadata } from "next";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { listFoods } from "@/lib/services/nutrition";
import { listRecipes, recipeTotalsBatch } from "@/lib/services/recipes";
import { measureDefaults } from "@/lib/services/measures";
import { recipeFoodOption } from "@/lib/recipes-ui";
import { getTimezone } from "@/lib/services/profile";
import { instant, num, plural } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DeleteRecipeForm, NewRecipeDialog } from "@/components/nutrition/recipe-forms";
import { NutritionNav } from "@/components/nutrition/nutrition-nav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Recipes" };

const PAGE_SIZE = 20;

function listHref(query: string, page: number, includeArchived: boolean): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (includeArchived) params.set("archived", "1");
  const text = params.toString();
  return text ? `/nutrition/recipes?${text}` : "/nutrition/recipes";
}

export default async function RecipesPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const query = (typeof params.q === "string" ? params.q.trim() : "").slice(0, 120);
  const includeArchived = params.archived === "1";
  const requested = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
  const recipeOutcome =
    params.recipe === "deleted" || params.recipe === "archived" ? params.recipe : null;

  const requestedPage = Number.isFinite(requested) ? Math.max(1, Math.trunc(requested)) : 1;
  let result = listRecipes({
    query,
    includeArchived,
    limit: PAGE_SIZE,
    offset: (requestedPage - 1) * PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  if (page !== requestedPage) {
    result = listRecipes({
      query,
      includeArchived,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
  }
  const totalsByRecipe = recipeTotalsBatch(result.items);
  const timezone = getTimezone();
  const initialFoods = listFoods({ limit: 100 }).items.map(recipeFoodOption);
  const defaultMeasures = measureDefaults();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
            <p className="text-sm text-muted-foreground">
              {plural(result.total, "recipe")} · totals are computed from the ingredients
            </p>
          </div>
          <NewRecipeDialog initialFoods={initialFoods} defaultMeasures={defaultMeasures} />
        </div>
      </div>

      <NutritionNav />

      {recipeOutcome ? (
        <p role="status" className="rounded-xl border border-border px-4 py-3 text-sm">
          {recipeOutcome === "archived"
            ? "Recipe archived — logged meals stay intact."
            : "Recipe deleted."}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-1">
          <Button asChild variant={includeArchived ? "ghost" : "secondary"} size="xs">
            <Link href={listHref(query, 1, false)} aria-current={includeArchived ? undefined : "true"}>
              Active
            </Link>
          </Button>
          <Button asChild variant={includeArchived ? "secondary" : "ghost"} size="xs">
            <Link href={listHref(query, 1, true)} aria-current={includeArchived ? "true" : undefined}>
              Include archived
            </Link>
          </Button>
        </div>
        <form method="get" role="search" className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          {includeArchived ? <input type="hidden" name="archived" value="1" /> : null}
          <Input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Recipe name"
            aria-label="Search recipes"
            maxLength={120}
            className="h-11 flex-1 sm:h-8 sm:w-56 sm:flex-none"
          />
          {query ? (
            <Button asChild variant="ghost" size="icon-sm" className="max-sm:size-11" aria-label="Clear search" title="Clear search">
              <Link href={listHref("", 1, includeArchived)}>×</Link>
            </Button>
          ) : null}
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
      </div>

      {result.items.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-border p-6">
          <p className="text-sm text-muted-foreground">
            {query ? (
              <>
                No recipes match “{query}”.{" "}
                <Link className="underline underline-offset-4" href={listHref("", 1, includeArchived)}>
                  Clear search
                </Link>
              </>
            ) : includeArchived ? (
              "No recipes yet."
            ) : (
              "No active recipes yet."
            )}
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/nutrition/recipes/new">Create a recipe</Link>
          </Button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {result.items.map((item) => {
            const totals = totalsByRecipe.get(item.id) ?? null;
            const resolvedCount = totals?.resolvedCount ?? 0;
            const partial = !item.complete && resolvedCount > 0;
            return (
              <li key={item.id} className="min-w-0">
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="min-w-0 text-base" role="heading" aria-level={2}>
                      <Link
                        href={`/nutrition/recipes/${item.id}`}
                        className="block truncate underline-offset-4 hover:underline"
                        title={item.name}
                      >
                        {item.name}
                      </Link>
                    </CardTitle>
                    <CardDescription>{plural(item.servingsTotal, "serving")}</CardDescription>
                    {item.archived || !item.complete ? (
                      <CardAction>
                        <span className="flex flex-wrap items-center justify-end gap-1">
                          {item.archived ? <Badge variant="secondary">archived</Badge> : null}
                          {!item.complete ? <Badge variant="outline">incomplete</Badge> : null}
                        </span>
                      </CardAction>
                    ) : null}
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-1">
                    {totals === null ? (
                      <p className="text-sm text-muted-foreground">Totals unavailable — refresh the list.</p>
                    ) : item.complete ? (
                      <>
                        <p className="num text-sm">
                          {num(totals.perServing.macros.kcal, 0)} kcal ·{" "}
                          {num(totals.perServing.macros.proteinG, 1)} g protein
                        </p>
                        <p className="num text-xs text-muted-foreground">
                          per serving · {num(totals.perServing.grams)} g
                        </p>
                      </>
                    ) : partial ? (
                      <>
                        <p className="text-sm">Incomplete — nutrition unknown</p>
                        <p className="num text-xs text-muted-foreground">
                          Resolved ingredients only: {num(totals.perServing.macros.kcal, 0)} kcal ·{" "}
                          {num(totals.perServing.macros.proteinG, 1)} g protein per serving ·{" "}
                          {item.unresolvedCount} unresolved
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm">Incomplete — nutrition unknown</p>
                        <p className="text-xs text-muted-foreground">
                          No ingredient has a saved food yet.
                        </p>
                      </>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Updated {instant(item.updatedAtMs, timezone)}
                    </p>
                  </CardContent>
                  <CardFooter className="justify-between gap-2">
                    <span className="flex items-center gap-1">
                      {!item.archived ? (
                        <>
                          <Button asChild variant="ghost" size="icon-sm" className="max-sm:size-11" aria-label={`Edit ${item.name}`} title={`Edit ${item.name}`}>
                            <Link href={`/nutrition/recipes/${item.id}/edit`}>
                              <Pencil aria-hidden />
                            </Link>
                          </Button>
                          <DeleteRecipeForm id={item.id} name={item.name} />
                        </>
                      ) : null}
                    </span>
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/nutrition/recipes/${item.id}`}>Open</Link>
                    </Button>
                  </CardFooter>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 ? (
        <nav aria-label="Recipe pages" className="flex items-center justify-between gap-3 text-sm">
          {page > 1 ? (
            <Link
              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 sm:min-h-0"
              href={listHref(query, page - 1, includeArchived)}
              rel="prev"
            >
              Previous
            </Link>
          ) : (
            <span className="text-muted-foreground">Previous</span>
          )}
          <span className="num text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 sm:min-h-0"
              href={listHref(query, page + 1, includeArchived)}
              rel="next"
            >
              Next
            </Link>
          ) : (
            <span className="text-muted-foreground">Next</span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
