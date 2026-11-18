import type { Metadata } from "next";
import { workoutsBetween } from "@/db/queries";
import { addDays } from "@/lib/day";
import { currentDay } from "@/lib/services/context";
import { getProfile } from "@/lib/services/profile";
import {
  exerciseProgression,
  listStrengthSessions,
  recentExercises,
  strengthContext,
} from "@/lib/services/strength";
import { MAX_WEEK_OFFSET } from "@/lib/services/training";
import { resolveUnits } from "@/lib/units";
import {
  StrengthLogSection,
  type StrengthWorkoutOption,
} from "@/components/training/strength-log";
import { SubviewHeader, SubviewNav } from "@/components/subviews/subview-header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Strength" };

const SECTIONS = [
  { href: "/training", label: "Overview" },
  { href: "/training/plan", label: "Plan" },
  { href: "/training/strength", label: "Strength" },
  { href: "/workouts", label: "Workouts" },
] as const;

export default async function ActivityStrengthPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const today = currentDay();
  const units = resolveUnits(getProfile().units);

  const sessions = listStrengthSessions(14);
  const exercises = recentExercises(20);
  const requestedExercise = typeof params.exercise === "string" ? params.exercise.trim() : "";
  const selectedExercise =
    requestedExercise !== "" && requestedExercise.length <= 120
      ? requestedExercise
      : (exercises[0] ?? null);
  const exerciseOptions =
    selectedExercise !== null && !exercises.includes(selectedExercise)
      ? [selectedExercise, ...exercises]
      : exercises;
  const progression = selectedExercise === null ? [] : exerciseProgression(selectedExercise, 8);
  const strengthWeek = strengthContext();

  const workoutOptions: StrengthWorkoutOption[] = workoutsBetween(addDays(today, -13), today).map(
    (workout) => ({
      id: workout.id,
      day: workout.day,
      type: workout.type,
      minutes: workout.minutes,
      km: workout.km,
    }),
  );

  const requestedWeek = typeof params.week === "string" ? Number.parseInt(params.week, 10) : 0;
  const weekOffset = Number.isFinite(requestedWeek)
    ? Math.min(Math.max(0, Math.trunc(requestedWeek)), MAX_WEEK_OFFSET)
    : 0;

  return (
    <div className="flex flex-col gap-8">
      <SubviewHeader
        title="Strength"
        description="Manual sets and loads, kept separate from imported workout totals."
        backHref="/training"
        backLabel="Activity overview"
      >
        <SubviewNav label="Activity sections" items={SECTIONS} activeHref="/training/strength" />
      </SubviewHeader>

      <StrengthLogSection
        today={today}
        units={units}
        sessions={sessions}
        exercises={exerciseOptions}
        selectedExercise={selectedExercise}
        progression={progression}
        workoutOptions={workoutOptions}
        sessionsThisWeek={strengthWeek.sessionsThisWeek}
        weekOffset={weekOffset}
      />
    </div>
  );
}
