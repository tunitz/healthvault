import type { Metadata } from "next";
import Link from "next/link";
import { Pencil } from "lucide-react";
import {
  getFood,
  getFoodRevisions,
  listFoods,
  type Food,
} from "@/lib/services/nutrition";
import { getTimezone } from "@/lib/services/profile";
import {
  changedFoodFields,
  foodIsEstimated,
  storedMeasureRows,
  type FoodFormValues,
  type FoodRevisionSummary,
} from "@/lib/foods-ui";
import { instant, num, plural } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeleteFoodForm, FoodForm } from "@/components/nutrition/food-forms";
import { NutritionNav } from "@/components/nutrition/nutrition-nav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Foods" };

const PAGE_SIZE = 20;

const STATE_LABEL: Record<string, string> = {
  raw: "Raw",
  cooked: "Cooked",
  dry: "Dry",
  rehydrated: "Rehydrated",
  none: "No basis",
};

const BASIS_TITLE: Record<string, string> = {
  raw: "Per-100 g values are for the raw food; yield factor converts cooked grams to raw.",
  cooked: "Per-100 g values are for the cooked food.",
  dry: "Per-100 g values are for the dry food; yield factor converts cooked grams to dry.",
  rehydrated: "Per-100 g values are for the rehydrated food.",
  none: "Per-100 g values as sold or eaten; no raw/cooked basis.",
};

function listHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `/nutrition/foods?${text}` : "/nutrition/foods";
}

function editHref(query: string, page: number, id: number): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  params.set("edit", String(id));
  return `/nutrition/foods?${params.toString()}#edit`;
}

function toFormValues(food: Food): FoodFormValues {
  return {
    id: food.id,
    name: food.name,
    brand: food.brand,
    barcode: food.barcode,
    servingGrams: food.servingGrams,
    kcalPer100g: food.kcalPer100g,
    proteinPer100g: food.proteinPer100g,
    carbsPer100g: food.carbsPer100g,
    fatPer100g: food.fatPer100g,
    fibrePer100g: food.fibrePer100g,
    sodiumPer100g: food.sodiumPer100g,
    state: food.state,
    yieldFactor: food.yieldFactor,
    measures: storedMeasureRows(food.measuresJson),
    source: food.source,
    sourceUrl: food.sourceUrl,
    sourceDate: food.sourceDate,
    estimated: foodIsEstimated(food),
  };
}

function SourceBadge({ source }: { source: string }) {
  return <Badge variant={source === "manual" ? "outline" : "secondary"}>{source}</Badge>;
}

export default async function FoodsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  // The service caps a search at 120 characters; a long URL must not turn the page into an error.
  const query = (typeof params.q === "string" ? params.q.trim() : "").slice(0, 120);
  const requested = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;

  // The bounded list query returns the total, so clamp a stale page before fetching the rows.
  const count = listFoods({ query, limit: 1 }).total;
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const page = Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.trunc(requested)), totalPages)
    : 1;
  const result = listFoods({ query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const items = result.items;
  const total = result.total;
  const firstRow = items.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const lastRow = firstRow + items.length - 1;

  const editParam = typeof params.edit === "string" ? Number.parseInt(params.edit, 10) : Number.NaN;
  let editing: Food | null = null;
  let editMissing = false;
  if (Number.isFinite(editParam) && editParam > 0) {
    try {
      editing = getFood(editParam);
    } catch {
      editMissing = true;
    }
  }

  const timezone = getTimezone();
  const revisions: FoodRevisionSummary[] = editing
    ? getFoodRevisions(editing.id).map((revision) => ({
        id: revision.id,
        at: revision.createdAtMs,
        changed: changedFoodFields(revision.previousJson, revision.currentJson),
      }))
    : [];
  const cancelHref = listHref(query, page);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Foods</h1>
        <p className="text-sm text-muted-foreground">
          {plural(total, "saved food")} · values are per 100 g in the stated basis
        </p>
      </div>

      <NutritionNav />

      {editing ? (
        <Card id="edit" className="scroll-mt-20">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>Edit {editing.name}</CardTitle>
            <CardDescription>A saved change never rewrites already-logged meals.</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <Link href={cancelHref}>Close</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <FoodForm key={editing.id} food={toFormValues(editing)} cancelHref={cancelHref} />
          </CardContent>
        </Card>
      ) : (
        <details className="rounded-xl border border-border" open={total === 0}>
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">New food</summary>
          <div className="border-t border-border p-4">
            <FoodForm cancelHref={cancelHref} />
          </div>
        </details>
      )}

      {editMissing ? (
        <p role="alert" className="text-sm text-destructive">
          That food no longer exists. <Link className="underline underline-offset-4" href={cancelHref}>Return to the list</Link>.
        </p>
      ) : null}

      {editing && revisions.length > 0 ? (
        <details className="rounded-xl border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            History <span className="text-xs font-normal text-muted-foreground">({revisions.length})</span>
          </summary>
          <div className="flex flex-col gap-2 border-t border-border p-4">
            <ul className="flex max-h-64 flex-col gap-2 overflow-auto text-xs">
              {revisions.map((revision) => (
                <li key={revision.id} className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">{instant(revision.at, timezone)}</span>
                  <span>{revision.changed.length > 0 ? revision.changed.join(", ") : "Definition updated"}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Logged meals keep their own snapshots.</p>
          </div>
        </details>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-medium">Saved foods</h2>
            <p className="text-xs text-muted-foreground">
              {items.length > 0
                ? `Showing ${firstRow}–${lastRow} of ${plural(total, "food")}`
                : plural(total, "food")}
              {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ""}
            </p>
          </div>
          <form method="get" role="search" className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <Input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Name or brand"
              aria-label="Search foods"
              className="h-11 flex-1 sm:h-8 sm:w-56 sm:flex-none"
            />
            <Button type="submit" variant="outline" size="sm">
              Search
            </Button>
          </form>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {query ? (
              <>
                No foods match “{query}”.{" "}
                <Link className="underline underline-offset-4" href="/nutrition/foods">
                  Clear search
                </Link>
              </>
            ) : (
              "No saved foods yet."
            )}
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Food</TableHead>
                  <TableHead className="hidden sm:table-cell">Basis</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Per 100 g</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((food) => (
                  <TableRow key={food.id}>
                    <TableCell className="min-w-0 whitespace-normal">
                      <div className="flex flex-col gap-1">
                        <span className="block max-w-[7.5rem] truncate font-medium sm:max-w-[22rem]" title={food.name}>
                          {food.name}
                        </span>
                        <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          {food.brand ? (
                            <span className="max-w-[7.5rem] truncate sm:max-w-[16rem]" title={food.brand}>
                              {food.brand}
                            </span>
                          ) : null}
                          <SourceBadge source={food.source} />
                          {food.source !== "estimated" && foodIsEstimated(food) ? (
                            <Badge variant="outline">estimate</Badge>
                          ) : null}
                          {/* The basis and per-100 g columns are hidden on phones; both meanings stay
                              visible next to the name instead of forcing a sideways scroll. */}
                          <span className="sm:hidden">
                            <Badge variant="outline" title={BASIS_TITLE[food.state] ?? food.state}>
                              {STATE_LABEL[food.state] ?? food.state}
                            </Badge>
                          </span>
                        </span>
                        <span className="num text-xs text-muted-foreground sm:hidden">
                          {num(food.kcalPer100g, 1)} kcal · {num(food.proteinPer100g, 1)} g protein / 100 g
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge
                        variant={food.state === "cooked" ? "secondary" : "outline"}
                        title={BASIS_TITLE[food.state] ?? food.state}
                      >
                        {STATE_LABEL[food.state] ?? food.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="num hidden text-right sm:table-cell">
                      <span className="block">{num(food.kcalPer100g, 1)} kcal</span>
                      <span className="block text-xs text-muted-foreground">
                        {num(food.proteinPer100g, 1)} g protein
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          asChild
                          variant="ghost"
                          size="icon-sm"
                          className="max-sm:size-11"
                          aria-label={`Edit ${food.name}`}
                          title={`Edit ${food.name}`}
                        >
                          <Link href={editHref(query, page, food.id)}>
                            <Pencil aria-hidden />
                          </Link>
                        </Button>
                        <DeleteFoodForm id={food.id} name={food.name} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {totalPages > 1 ? (
              <nav aria-label="Food pages" className="flex items-center justify-between gap-3 text-sm">
                {page > 1 ? (
                  <Link
                    className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 sm:min-h-0"
                    href={listHref(query, page - 1)}
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
                    href={listHref(query, page + 1)}
                    rel="next"
                  >
                    Next
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Next</span>
                )}
              </nav>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
