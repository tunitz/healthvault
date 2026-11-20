import type { Metadata } from "next";
import { ageOf, getProfile, getTimezone, trainingGoal, workSchedule } from "@/lib/services/profile";
import {
  measurementHistory,
  type MeasurementKind,
  type Point,
} from "@/lib/services/measurements";
import { localClockNow } from "@/lib/day";
import { currentDay } from "@/lib/services/context";
import { num } from "@/lib/format";
import { formatHeight, formatWaist, formatWeight, resolveUnits } from "@/lib/units";
import { ProfileForm, WorkScheduleForm } from "@/components/profile/profile-form";
import { MeasurementForm } from "@/components/profile/measurement-form";
import { MeasurementTabs } from "@/components/profile/measurement-tabs";
import { SubviewNav } from "@/components/subviews/subview-header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Profile" };

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num text-xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function formatLatest(latest: Point | null, kind: MeasurementKind, units: "metric" | "imperial"): string {
  if (!latest) return "—";
  if (kind === "weight") return formatWeight(latest.value, units);
  if (kind === "waist") return formatWaist(latest.value, units);
  return `${num(latest.value, 1)} %`;
}

export default function ProfilePage() {
  const profile = getProfile();
  const units = resolveUnits(profile.units);
  const timezone = getTimezone();
  const today = currentDay();
  const age = ageOf(profile, today);
  const schedule = workSchedule(profile);
  const goal = trainingGoal(profile);
  const weight = measurementHistory("weight", 3650);
  const bodyFat = measurementHistory("bodyFat", 3650);
  const waist = measurementHistory("waist", 3650);
  const latestWeight = weight.at(-1) ?? null;
  const latestBodyFat = bodyFat.at(-1) ?? null;
  const latestWaist = waist.at(-1) ?? null;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
          <p className="text-sm text-muted-foreground">
            Facts the agent reads before asking. Today is {today} ({timezone}).
          </p>
        </div>
        <SubviewNav
          label="Profile sections"
          items={[
            { href: "/profile", label: "Profile" },
            { href: "/measurements", label: "Measurements" },
          ]}
          activeHref="/profile"
        />
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Personal details</h2>
          {profile.heightCm ? (
            <p className="text-xs text-muted-foreground">Height {formatHeight(profile.heightCm, units)}</p>
          ) : null}
        </div>
        <ProfileForm profile={profile} age={age} units={units} goalSeconds={goal.targetSeconds} />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Work schedule</h2>
        </div>
        <WorkScheduleForm schedule={schedule} />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Body measurements</h2>
          <p className="text-xs text-muted-foreground">Weight, body fat, and waist trends and logs.</p>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Metric label="Latest weight" value={formatLatest(latestWeight, "weight", units)} hint={latestWeight?.day} />
          <Metric
            label="Goal weight"
            value={profile.goalWeightKg === null ? "—" : formatWeight(profile.goalWeightKg, units)}
            hint={profile.goalWeightKg === null ? "Not set" : "From profile"}
          />
          <Metric label="Body fat" value={formatLatest(latestBodyFat, "bodyFat", units)} hint={latestBodyFat?.day ?? "Manual only"} />
          <Metric label="Waist" value={formatLatest(latestWaist, "waist", units)} hint={latestWaist?.day ?? "Manual only"} />
        </div>

        <div className="rounded-xl border border-border p-4">
          <h3 className="mb-3 text-sm font-medium">Add a measurement</h3>
          <MeasurementForm today={today} defaultTime={localClockNow(timezone)} units={units} />
        </div>

        <MeasurementTabs
          weight={weight}
          bodyFat={bodyFat}
          waist={waist}
          goalKg={profile.goalWeightKg}
          timezone={timezone}
          units={units}
        />
      </section>
    </div>
  );
}
