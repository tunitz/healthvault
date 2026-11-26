import type { Metadata } from "next";
import { fiveKAttempts, fiveKBest, workoutsBetween } from "@/db/queries";
import { currentDay, dataFreshness } from "@/lib/services/context";
import { getProfile, trainingGoal } from "@/lib/services/profile";
import { currentBlock, nextMonday } from "@/lib/services/training-plan";
import { resolveUnits } from "@/lib/units";
import {
  FiveKGoalSection,
  TrainingBlockSection,
  type WorkoutOption,
} from "@/components/training/plan-sections";
import { SubviewHeader, SubviewNav } from "@/components/subviews/subview-header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Activity plan" };

const SECTIONS = [
  { href: "/training", label: "Overview" },
  { href: "/training/plan", label: "Plan" },
  { href: "/training/strength", label: "Strength" },
  { href: "/workouts", label: "Workouts" },
] as const;

export default function ActivityPlanPage() {
  const today = currentDay();
  const profile = getProfile();
  const units = resolveUnits(profile.units);
  const goal = trainingGoal(profile);
  const fresh = dataFreshness();

  const attempts = fiveKAttempts(365);
  const best = fiveKBest(365);
  const block = currentBlock();
  const blockWorkouts = block === null ? [] : workoutsBetween(block.weekStart, block.weekEnd);
  const workoutOptions: Record<string, WorkoutOption[]> = {};
  for (const workout of blockWorkouts) {
    (workoutOptions[workout.day] ??= []).push({
      id: workout.id,
      type: workout.type,
      minutes: workout.minutes,
      km: workout.km,
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <SubviewHeader
        title="Plan"
        description={`5K goal and training block · Apple data through ${fresh.lastRecordDay ?? "—"}`}
        backHref="/training"
        backLabel="Activity overview"
      >
        <SubviewNav label="Activity sections" items={SECTIONS} activeHref="/training/plan" />
      </SubviewHeader>

      <FiveKGoalSection goal={goal} attempts={attempts} best={best} units={units} />

      <TrainingBlockSection
        block={block}
        defaultStart={nextMonday(today)}
        workoutOptions={workoutOptions}
        units={units}
      />
    </div>
  );
}
