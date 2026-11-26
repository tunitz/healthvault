import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { SubviewHeader } from "@/components/subviews/subview-header";
import { RouteViewer } from "@/components/workouts/route-viewer";
import { workoutDetail } from "@/db/queries";
import { dayHeading } from "@/lib/day";
import { duration, hrZone, num, workoutLabel } from "@/lib/format";
import { getProfile } from "@/lib/services/profile";
import { formatDistance, formatPace, formatWeight, resolveUnits } from "@/lib/units";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Workout detail" };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num text-xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default async function WorkoutDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await props.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) notFound();

  const detail = workoutDetail(id);
  if (!detail) notFound();

  const { workout, route, strengthSets, plannedSession } = detail;
  const units = resolveUnits(getProfile().units);
  const zone = hrZone(workout.avgHr);

  return (
    <div className="flex flex-col gap-8">
      <SubviewHeader
        title={workoutLabel(workout.type)}
        description={`${dayHeading(workout.day)} · ${workout.startDate.slice(11, 16)}–${workout.endDate.slice(11, 16)}${workout.sourceName ? ` · ${workout.sourceName}` : ""}`}
        backHref="/workouts"
        backLabel="Workouts"
      />

      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Duration" value={duration(workout.durationSeconds)} />
        <Stat label="Distance" value={formatDistance(workout.distanceKm, units, 2)} />
        <Stat label="Pace" value={formatPace(workout.paceMinPerKm, units)} />
        <Stat
          label="Avg HR"
          value={workout.avgHr === null ? "—" : `${num(workout.avgHr, 0)} bpm`}
          hint={workout.avgHr === null ? undefined : zone.label}
        />
        <Stat
          label="HR range"
          value={
            workout.minHr !== null || workout.maxHr !== null
              ? `${workout.minHr === null ? "—" : num(workout.minHr, 0)}–${workout.maxHr === null ? "—" : num(workout.maxHr, 0)}`
              : "—"
          }
          hint="min–max bpm"
        />
        <Stat
          label="Energy"
          value={
            workout.totalEnergyBurned === null
              ? "—"
              : `${num(workout.totalEnergyBurned, 0)} ${workout.totalEnergyBurnedUnit ?? "kcal"}`
          }
        />
      </div>

      {route ? (
        <RouteViewer route={route} units={units} />
      ) : (
        <div className="rounded-xl border border-border p-4 text-xs text-muted-foreground">
          No GPX route attached to this workout. Outdoor GPS workouts imported from Apple Health with{" "}
          <span className="font-mono">workout-routes/*.gpx</span> display their map and splits here.
        </div>
      )}

      {plannedSession ? (
        <section className="flex flex-col gap-2 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Linked training plan session</h2>
            <Badge variant="outline">{plannedSession.status}</Badge>
          </div>
          <p className="text-sm">
            {plannedSession.title}
            {plannedSession.weekNo ? ` · Week ${plannedSession.weekNo}` : ""}
          </p>
          <Link href="/training/plan" className="text-xs text-primary underline underline-offset-4">
            Open training plan
          </Link>
        </section>
      ) : null}

      {strengthSets.length > 0 ? (
        <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Linked strength sets</h2>
            <Link href="/training/strength" className="text-xs text-primary underline underline-offset-4">
              Strength log
            </Link>
          </div>
          <ul className="divide-y divide-border/60 text-sm">
            {strengthSets.map((set) => (
              <li key={set.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span>
                  <span className="num text-xs text-muted-foreground">#{set.setNo}</span> {set.exercise}
                </span>
                <span className="num text-xs text-muted-foreground">
                  {set.reps === null ? "—" : `${num(set.reps, 0)} reps`}
                  {set.loadKg === null ? "" : ` · ${formatWeight(set.loadKg, units)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
