import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubviewNav } from "@/components/subviews/subview-header";
import { allWorkouts, countWorkouts, workoutFilterOptions, workoutTotalsAll, type WorkoutFilters } from "@/db/queries";
import { isDay } from "@/lib/day";
import { duration, hrZone, num, plural, workoutLabel } from "@/lib/format";
import { formatDistance, formatPace, resolveUnits } from "@/lib/units";
import { getProfile } from "@/lib/services/profile";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Workouts" };

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="num text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

const SELECT =
  "h-9 max-sm:h-11 min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const PAGE_SIZE = 50;

function pageHref(page: number, filters: WorkoutFilters): string {
  const sp = new URLSearchParams();
  if (page > 1) sp.set("page", String(page));
  if (filters.type) sp.set("type", filters.type);
  if (filters.source) sp.set("source", filters.source);
  if (filters.fromDay) sp.set("from", filters.fromDay);
  if (filters.toDay) sp.set("to", filters.toDay);
  if (filters.query) sp.set("q", filters.query);
  const qs = sp.toString();
  return qs ? `/workouts?${qs}` : "/workouts";
}

export default async function WorkoutsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const units = resolveUnits(getProfile().units);

  const strParam = (k: string) => (typeof params[k] === "string" && params[k].trim() !== "" ? params[k].trim() : undefined);
  const fromParam = strParam("from");
  const toParam = strParam("to");
  const filters: WorkoutFilters = {
    type: strParam("type"),
    source: strParam("source"),
    fromDay: fromParam && isDay(fromParam) ? fromParam : undefined,
    toDay: toParam && isDay(toParam) ? toParam : undefined,
    query: strParam("q"),
  };
  const hasFilters = Boolean(filters.type || filters.source || filters.fromDay || filters.toDay || filters.query);

  const totals = workoutTotalsAll();
  const matchedTotal = hasFilters ? countWorkouts(filters) : totals.sessions;
  const filterOptions = workoutFilterOptions();
  const totalPages = Math.max(1, Math.ceil(matchedTotal / PAGE_SIZE));
  const requested = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
  const page = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), totalPages) : 1;
  const workouts = allWorkouts({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...filters });
  const firstRow = (page - 1) * PAGE_SIZE + 1;
  const lastRow = firstRow + workouts.length - 1;

  const groups: { key: string; label: string; rows: typeof workouts }[] = [];
  for (const workout of workouts) {
    const key = workout.day.slice(0, 7);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = {
        key,
        label: new Date(`${key}-01T12:00:00Z`).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
        rows: [],
      };
      groups.push(group);
    }
    group.rows.push(workout);
  }

  let previousSource: string | null = null;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Workouts</h1>
          <p className="text-sm text-muted-foreground">
            {hasFilters ? `${plural(matchedTotal, "matching workout")} of ${totals.sessions}` : plural(totals.sessions, "workout")}
            {workouts.length > 0 ? ` · showing rows ${firstRow}–${lastRow}` : ""}
          </p>
        </div>
        <SubviewNav
          label="Activity sections"
          items={[
            { href: "/training", label: "Overview" },
            { href: "/training/plan", label: "Plan" },
            { href: "/training/strength", label: "Strength" },
            { href: "/workouts", label: "Workouts" },
          ]}
          activeHref="/workouts"
        />
      </div>

      {totals.sessions === 0 ? (
        <p className="text-sm text-muted-foreground">
          No workouts yet. <Link className="text-primary underline underline-offset-4" href="/uploads">Import an export</Link> to see them here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
            <Metric title="Total time" value={duration(totals.seconds)} />
            <Metric title="Total distance" value={formatDistance(totals.km, units)} />
            <Metric title="Total energy" value={`${num(totals.kcal, 0)} kcal`} />
          </div>

          <form method="get" className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2 lg:grid-cols-6">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground lg:col-span-2">
              <span>Search</span>
              <Input
                type="search"
                name="q"
                defaultValue={filters.query ?? ""}
                placeholder="Activity, source, or YYYY-MM"
                className="h-9 max-sm:h-11"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>Activity</span>
              <select name="type" defaultValue={filters.type ?? ""} className={SELECT}>
                <option value="">All types</option>
                {filterOptions.types.map((t) => (
                  <option key={t} value={t}>
                    {workoutLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>Source</span>
              <select name="source" defaultValue={filters.source ?? ""} className={SELECT}>
                <option value="">All sources</option>
                {filterOptions.sources.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>From</span>
              <Input type="date" name="from" defaultValue={filters.fromDay ?? ""} className="h-9 max-sm:h-11" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>To</span>
              <Input type="date" name="to" defaultValue={filters.toDay ?? ""} className="h-9 max-sm:h-11" />
            </label>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-6">
              <Button type="submit" size="sm">Apply filters</Button>
              {hasFilters ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/workouts">Clear</Link>
                </Button>
              ) : null}
            </div>
          </form>

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-medium">{hasFilters ? "Filtered workouts" : "All workouts"}</h2>
              <p className="text-xs text-muted-foreground">
                {totalPages > 1 ? `Page ${page} of ${totalPages} · ` : ""}
                Click any session for route map, splits, HR stats, and linked strength sets.
              </p>
            </div>
            {workouts.length === 0 ? (
              <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
                No workouts match these filters.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead>Activity</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Distance</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Pace</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Avg HR</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Max HR</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Energy</TableHead>
                    <TableHead className="hidden md:table-cell">Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((group) => (
                    <Fragment key={group.key}>
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableCell colSpan={9} className="py-1.5 text-xs font-medium text-muted-foreground">
                          {group.label}
                        </TableCell>
                      </TableRow>
                      {group.rows.map((w) => {
                        const zone = hrZone(w.avgHr);
                        const source = w.sourceName ?? "—";
                        const showSource = source !== previousSource;
                        previousSource = source;
                        const km = w.distanceKm;
                        return (
                          <Fragment key={w.id}>
                            <TableRow className="align-top">
                              <TableCell className="num">
                                <Link href={`/workouts/${w.id}`} className="hover:underline underline-offset-4">
                                  <span className="md:hidden">{w.day.slice(5)}</span>
                                  <span className="hidden md:inline">{w.day}</span>
                                </Link>
                              </TableCell>
                              <TableCell>
                                <Link
                                  href={`/workouts/${w.id}`}
                                  className="inline-flex max-w-full items-center gap-1.5 font-medium hover:text-primary hover:underline underline-offset-4"
                                >
                                  <span className="truncate max-w-[6.5rem] sm:max-w-[9rem] md:max-w-none">
                                    {workoutLabel(w.type)}
                                  </span>
                                  {w.hasRoute ? (
                                    <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px]" title="Has GPS route">
                                      <MapPin aria-hidden className="size-2.5" />
                                      GPS
                                    </Badge>
                                  ) : null}
                                </Link>
                              </TableCell>
                              <TableCell className="num text-right">{duration(w.durationSeconds)}</TableCell>
                              <TableCell className="num text-right">{formatDistance(km, units, 2)}</TableCell>
                              <TableCell className="num hidden text-right md:table-cell">
                                {formatPace(w.paceMinPerKm, units)}
                              </TableCell>
                              <TableCell className="num hidden text-right md:table-cell">
                                {w.avgHr === null ? (
                                  "—"
                                ) : (
                                  <span className="inline-flex items-center justify-end gap-1.5">
                                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${zone.dot}`} />
                                    <span>
                                      {num(w.avgHr, 0)} {zone.label}
                                    </span>
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="num hidden text-right md:table-cell">
                                {w.maxHr === null ? "—" : num(w.maxHr, 0)}
                              </TableCell>
                              <TableCell className="num hidden text-right md:table-cell">
                                {w.totalEnergyBurned === null
                                  ? "—"
                                  : `${num(w.totalEnergyBurned, 0)} ${w.totalEnergyBurnedUnit ?? "kcal"}`}
                              </TableCell>
                              <TableCell className="hidden text-muted-foreground md:table-cell">
                                <span className={showSource ? undefined : "opacity-65"}>{source}</span>
                              </TableCell>
                            </TableRow>
                            <TableRow className="md:hidden hover:bg-transparent">
                              <TableCell colSpan={4} className="pt-0 pb-2">
                                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                  <div className="flex gap-1">
                                    <dt>Pace</dt>
                                    <dd className="num text-foreground">{formatPace(w.paceMinPerKm, units)}</dd>
                                  </div>
                                  <div className="flex gap-1">
                                    <dt>Avg HR</dt>
                                    <dd className="num text-foreground">
                                      {w.avgHr === null ? "—" : `${num(w.avgHr, 0)} ${zone.label}`}
                                    </dd>
                                  </div>
                                  <div className="flex gap-1">
                                    <dt>Energy</dt>
                                    <dd className="num text-foreground">
                                      {w.totalEnergyBurned === null
                                        ? "—"
                                        : `${num(w.totalEnergyBurned, 0)} ${w.totalEnergyBurnedUnit ?? "kcal"}`}
                                    </dd>
                                  </div>
                                </dl>
                              </TableCell>
                            </TableRow>
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            )}
            {totalPages > 1 ? (
              <nav aria-label="Workout pages" className="flex items-center justify-between gap-3 text-sm">
                {page > 1 ? (
                  <Link className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 sm:min-h-0" href={pageHref(page - 1, filters)} rel="prev">
                    Previous
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Previous</span>
                )}
                <span className="num text-xs text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 sm:min-h-0" href={pageHref(page + 1, filters)} rel="next">
                    Next
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Next</span>
                )}
              </nav>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
