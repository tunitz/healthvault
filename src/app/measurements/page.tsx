import type { Metadata } from "next";
import { MeasurementLog } from "@/components/profile/measurement-form";
import { MeasurementTabs } from "@/components/profile/measurement-tabs";
import { SubviewHeader } from "@/components/subviews/subview-header";
import { localClockNow } from "@/lib/day";
import { num } from "@/lib/format";
import { currentDay } from "@/lib/services/context";
import {
  measurementHistory,
  type MeasurementKind,
  type Point,
} from "@/lib/services/measurements";
import { getProfile, getTimezone } from "@/lib/services/profile";
import { formatWaist, formatWeight, resolveUnits } from "@/lib/units";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Measurements" };

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num truncate text-xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function formatLatest(latest: Point | null, kind: MeasurementKind, units: "metric" | "imperial"): string {
  if (!latest) return "—";
  if (kind === "weight") return formatWeight(latest.value, units);
  if (kind === "waist") return formatWaist(latest.value, units);
  return `${num(latest.value, 1)} %`;
}

export default function MeasurementsPage() {
  const profile = getProfile();
  const units = resolveUnits(profile.units);
  const timezone = getTimezone();
  const today = currentDay();
  const weight = measurementHistory("weight", 3650);
  const bodyFat = measurementHistory("bodyFat", 3650);
  const waist = measurementHistory("waist", 3650);
  const latestWeight = weight.at(-1) ?? null;
  const latestBodyFat = bodyFat.at(-1) ?? null;
  const latestWaist = waist.at(-1) ?? null;

  return (
    <div className="flex flex-col gap-8">
      <SubviewHeader
        title="Measurements"
        description="Log weight, body fat or waist. Apple BodyMass entries appear alongside manual ones."
        backHref="/profile"
        backLabel="Profile"
      />

      <section className="flex flex-col gap-3" aria-labelledby="add-measurement">
        <div className="flex flex-col gap-0.5">
          <h2 id="add-measurement" className="text-sm font-medium">Add a measurement</h2>
          <p className="text-xs text-muted-foreground">Saved with the day and local time you choose.</p>
        </div>
        <div>
          <MeasurementLog today={today} defaultTime={localClockNow(timezone)} units={units} />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="measurement-summary">
        <h2 id="measurement-summary" className="text-sm font-medium">Latest</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Metric label="Weight" value={formatLatest(latestWeight, "weight", units)} hint={latestWeight?.day} />
          <Metric
            label="Goal weight"
            value={profile.goalWeightKg === null ? "—" : formatWeight(profile.goalWeightKg, units)}
            hint={profile.goalWeightKg === null ? "Not set" : "From profile"}
          />
          <Metric label="Body fat" value={formatLatest(latestBodyFat, "bodyFat", units)} hint={latestBodyFat?.day ?? "Manual only"} />
          <Metric label="Waist" value={formatLatest(latestWaist, "waist", units)} hint={latestWaist?.day ?? "Manual only"} />
        </div>
      </section>

      <MeasurementTabs
        weight={weight}
        bodyFat={bodyFat}
        waist={waist}
        goalKg={profile.goalWeightKg}
        timezone={timezone}
        units={units}
      />
    </div>
  );
}
