import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allWorkouts, workoutTotalsAll } from "@/db/queries";
import { duration, hrZone, num, plural, workoutLabel } from "@/lib/format";
import { formatDistance, formatPace, resolveUnits, toCanonicalDistance } from "@/lib/units";
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

/** Stored distance is normally km; honour a mile-labelled row instead of converting it twice. */
function distanceKm(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return (unit ?? "km").toLowerCase() === "mi" ? toCanonicalDistance(value, "imperial") : value;
}

export default function WorkoutsPage() {
  const units = resolveUnits(getProfile().units);
  const workouts = allWorkouts();
  const totals = workoutTotalsAll();

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
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Workouts</h1>
        <p className="text-sm text-muted-foreground">
          {plural(totals.sessions, "workout")} in the database
          {workouts.length < totals.sessions ? ` · showing the newest ${workouts.length}` : ""}
        </p>
      </div>

      {workouts.length === 0 ? (
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

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-medium">All workouts</h2>
              <p className="text-xs text-muted-foreground">
                {num(workouts.length, 0)} of {plural(totals.sessions, "row")}, newest first
              </p>
            </div>
            <Table containerClassName="max-h-[70vh] overflow-auto">
              <TableHeader className="sticky top-0 z-10 bg-background [&_th]:bg-background">
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
                    {group.rows.map((w, i) => {
                    const zone = hrZone(w.avgHr);
                    const source = w.sourceName ?? "—";
                    const showSource = source !== previousSource;
                    previousSource = source;
                    const km = distanceKm(w.totalDistance, w.totalDistanceUnit);
                    return (
                      <Fragment key={`${w.startDate}-${i}`}>
                      <TableRow className="align-top">
                        <TableCell className="num">
                          <span className="md:hidden">{w.day.slice(5)}</span>
                          <span className="hidden md:inline">{w.day}</span>
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-[7.5rem] truncate md:max-w-none">{workoutLabel(w.type)}</span>
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
                          {showSource ? source : ""}
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
          </section>
        </>
      )}
    </div>
  );
}
