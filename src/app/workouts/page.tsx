import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allWorkouts, workoutTotalsAll } from "@/db/queries";
import { hrZone, minutes, num, plural, workoutLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

const ZONE_TEXT: Record<string, string> = {
  easy: "text-chart-1",
  steady: "text-chart-2",
  hard: "text-chart-4",
  max: "text-destructive",
};

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="num text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

export default function WorkoutsPage() {
  const workouts = allWorkouts();
  const totals = workoutTotalsAll();

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
            <Metric title="Total time" value={minutes(totals.seconds)} />
            <Metric title="Total distance" value={`${num(totals.km, 2)} km`} />
            <Metric title="Total energy" value={`${num(totals.kcal)} kcal`} />
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-medium">All workouts</h2>
              <p className="text-xs text-muted-foreground">
                Showing {num(workouts.length, 0)} of {plural(totals.sessions, "row")}, newest first
              </p>
            </div>
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
                {workouts.map((w, i) => (
                  <TableRow key={`${w.startDate}-${i}`}>
                    <TableCell className="num"><span className="md:hidden">{w.day.slice(5)}</span><span className="hidden md:inline">{w.day}</span></TableCell>
                    <TableCell><span className="block max-w-[7.5rem] truncate md:max-w-none">{workoutLabel(w.type)}</span></TableCell>
                    <TableCell className="num text-right">{minutes(w.durationSeconds)}</TableCell>
                    <TableCell className="num text-right">
                      {w.totalDistance === null ? "—" : `${num(w.totalDistance, 2)} ${w.totalDistanceUnit ?? ""}`}
                    </TableCell>
                    <TableCell className="num hidden text-right md:table-cell">
                      {w.paceMinPerKm === null ? "—" : `${num(w.paceMinPerKm, 2)} /km`}
                    </TableCell>
                    <TableCell className={`num hidden text-right md:table-cell ${ZONE_TEXT[hrZone(w.avgHr).label] ?? ""}`}>
                      {w.avgHr === null ? "—" : num(w.avgHr, 0)}
                    </TableCell>
                    <TableCell className="num hidden text-right md:table-cell">
                      {w.maxHr === null ? "—" : num(w.maxHr, 0)}
                    </TableCell>
                    <TableCell className="num hidden text-right md:table-cell">
                      {w.totalEnergyBurned === null
                        ? "—"
                        : `${num(w.totalEnergyBurned)} ${w.totalEnergyBurnedUnit ?? ""}`}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{w.sourceName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </>
      )}
    </div>
  );
}
