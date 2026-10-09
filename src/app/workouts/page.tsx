import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allWorkouts } from "@/db/queries";
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
  const totalSeconds = workouts.reduce((a, w) => a + (w.durationSeconds ?? 0), 0);
  const totalDistance = workouts
    .filter((w) => w.totalDistanceUnit === "km")
    .reduce((a, w) => a + (w.totalDistance ?? 0), 0);
  const totalEnergy = workouts
    .filter((w) => w.totalEnergyBurnedUnit === "kcal")
    .reduce((a, w) => a + (w.totalEnergyBurned ?? 0), 0);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Workouts</h1>
        <p className="text-sm text-muted-foreground">{plural(workouts.length, "workout")} in the database</p>
      </div>

      {workouts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No workouts yet. <Link className="text-primary underline underline-offset-4" href="/uploads">Import an export</Link> to see them here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
            <Metric title="Total time" value={minutes(totalSeconds)} />
            <Metric title="Distance (km workouts)" value={`${num(totalDistance, 2)} km`} />
            <Metric title="Energy (kcal workouts)" value={`${num(totalEnergy)} kcal`} />
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-medium">All workouts</h2>
              <p className="text-xs text-muted-foreground">Newest first, capped at 500 rows</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Distance</TableHead>
                  <TableHead className="text-right">Pace</TableHead>
                  <TableHead className="text-right">Avg HR</TableHead>
                  <TableHead className="text-right">Max HR</TableHead>
                  <TableHead className="text-right">Energy</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workouts.map((w, i) => (
                  <TableRow key={`${w.startDate}-${i}`}>
                    <TableCell className="num">{w.day}</TableCell>
                    <TableCell>{workoutLabel(w.type)}</TableCell>
                    <TableCell className="num text-right">{minutes(w.durationSeconds)}</TableCell>
                    <TableCell className="num text-right">
                      {w.totalDistance === null ? "—" : `${num(w.totalDistance, 2)} ${w.totalDistanceUnit ?? ""}`}
                    </TableCell>
                    <TableCell className="num text-right">
                      {w.paceMinPerKm === null ? "—" : `${num(w.paceMinPerKm, 2)} /km`}
                    </TableCell>
                    <TableCell className={`num text-right ${ZONE_TEXT[hrZone(w.avgHr).label] ?? ""}`}>
                      {w.avgHr === null ? "—" : num(w.avgHr, 0)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {w.maxHr === null ? "—" : num(w.maxHr, 0)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {w.totalEnergyBurned === null
                        ? "—"
                        : `${num(w.totalEnergyBurned)} ${w.totalEnergyBurnedUnit ?? ""}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{w.sourceName ?? "—"}</TableCell>
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
