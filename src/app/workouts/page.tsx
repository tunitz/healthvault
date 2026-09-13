import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allWorkouts } from "@/db/queries";
import { minutes, num, workoutLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workouts</h1>
        <p className="text-sm text-muted-foreground">{workouts.length} workouts in the database</p>
      </div>

      {workouts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workouts yet — upload an Export.zip first.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardDescription>Total time</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{minutes(totalSeconds)}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Total distance (km workouts)</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{num(totalDistance, 2)} km</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Total energy (kcal workouts)</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{num(totalEnergy)} kcal</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>All workouts</CardTitle>
              <CardDescription>Newest first, capped at 500 rows</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead>Activity</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Distance</TableHead>
                    <TableHead className="text-right">Energy</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workouts.map((w, i) => (
                    <TableRow key={`${w.startDate}-${i}`}>
                      <TableCell className="tabular-nums">{w.day}</TableCell>
                      <TableCell>{workoutLabel(w.type)}</TableCell>
                      <TableCell className="text-right tabular-nums">{minutes(w.durationSeconds)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.totalDistance === null ? "—" : `${num(w.totalDistance, 2)} ${w.totalDistanceUnit ?? ""}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.totalEnergyBurned === null
                          ? "—"
                          : `${num(w.totalEnergyBurned)} ${w.totalEnergyBurnedUnit ?? ""}`}
                      </TableCell>
                      <TableCell>{w.sourceName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
