import type { Metadata } from "next";
import { ageOf, getProfile, getTimezone, workSchedule } from "@/lib/services/profile";
import {
  latestMeasurement,
  measurementHistory,
  type MeasurementKind,
} from "@/lib/services/measurements";
import { formatLocal, localClockNow } from "@/lib/day";
import { currentDay } from "@/lib/services/context";
import { num } from "@/lib/format";
import { formatHeight, formatWaist, formatWeight, resolveUnits } from "@/lib/units";
import { Badge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { deleteMeasurementAction } from "@/app/actions";
import { ProfileForm, WorkScheduleForm } from "@/components/profile/profile-form";
import { MeasurementForm } from "@/components/profile/measurement-form";
import { WeightChart } from "@/components/profile/weight-chart";

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

function latestText(kind: MeasurementKind, units: "metric" | "imperial"): string {
  const latest = latestMeasurement(kind);
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
  const history = measurementHistory("weight", 3650);
  const table = [...history].reverse().slice(0, 60);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Facts the agent reads before asking. Today is {today} ({timezone}).
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Personal details</h2>
          {profile.heightCm ? (
            <p className="text-xs text-muted-foreground">Height {formatHeight(profile.heightCm, units)}</p>
          ) : null}
        </div>
        <ProfileForm profile={profile} age={age} units={units} />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Work schedule</h2>
        </div>
        <WorkScheduleForm schedule={schedule} />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Weight log</h2>
          <p className="text-xs text-muted-foreground">Manual and Apple BodyMass entries are both shown.</p>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Metric label="Latest weight" value={latestText("weight", units)} hint={latestMeasurement("weight")?.day} />
          <Metric
            label="Goal weight"
            value={profile.goalWeightKg === null ? "—" : formatWeight(profile.goalWeightKg, units)}
            hint={profile.goalWeightKg === null ? "Not set" : "From profile"}
          />
          <Metric label="Body fat" value={latestText("bodyFat", units)} hint={latestMeasurement("bodyFat")?.day ?? "Manual only"} />
          <Metric label="Waist" value={latestText("waist", units)} hint={latestMeasurement("waist")?.day ?? "Manual only"} />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border border-border p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-[var(--chart-1)]" /> Manual
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-[var(--chart-2)]" /> Apple
              </span>
            </div>
            <WeightChart
              points={history}
              goalKg={profile.goalWeightKg}
              timezone={timezone}
              units={units}
            />
          </div>

          <div className="rounded-xl border border-border p-4">
            <h3 className="text-sm font-medium">Add a measurement</h3>
            <MeasurementForm today={today} defaultTime={localClockNow(timezone)} units={units} />
          </div>
        </div>

        {table.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground md:hidden">No weight entries yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60 md:hidden">
            {table.map((point) => {
              const when = formatLocal(point.takenAtMs, timezone);
              return (
                <li key={`${point.source}-${point.takenAtMs}`} className="flex flex-col gap-1 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="num text-sm">{formatWeight(point.value, units)}</p>
                      <p className="num text-xs text-muted-foreground">{when}</p>
                    </div>
                    <Badge variant={point.source === "manual" ? "default" : "outline"}>
                      {point.source === "manual" ? "manual" : "Apple"}
                    </Badge>
                  </div>
                  {point.note ? (
                    <p className="break-words text-xs text-muted-foreground">{point.note}</p>
                  ) : null}
                  {point.source === "manual" && point.id !== null ? (
                    <ActionForm
                      action={deleteMeasurementAction}
                      className="mt-1"
                      confirm={`Delete the weight entry from ${when}? This cannot be undone.`}
                    >
                      <input type="hidden" name="id" value={point.id} />
                      <SubmitButton
                        variant="ghost"
                        size="xs"
                        aria-label={`Delete weight entry from ${when}`}
                      >
                        Delete
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Weight</th>
                <th className="py-2 pr-3 font-medium">Source</th>
                <th className="py-2 pr-3 font-medium">Note</th>
                <th className="py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {table.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-sm text-muted-foreground">
                    No weight entries yet.
                  </td>
                </tr>
              ) : (
                table.map((point) => {
                  const when = formatLocal(point.takenAtMs, timezone);
                  return (
                    <tr key={`${point.source}-${point.takenAtMs}`} className="border-b border-border/60">
                      <td className="num py-2 pr-3 text-muted-foreground">{when}</td>
                      <td className="num py-2 pr-3">{formatWeight(point.value, units)}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={point.source === "manual" ? "default" : "outline"}>
                          {point.source === "manual" ? "manual" : "Apple"}
                        </Badge>
                      </td>
                      <td className="max-w-[220px] truncate py-2 pr-3 text-muted-foreground">
                        {point.note ?? "—"}
                      </td>
                      <td className="py-2 text-right">
                        {point.source === "manual" && point.id !== null ? (
                          <ActionForm
                            action={deleteMeasurementAction}
                            className="inline-flex"
                            confirm={`Delete the weight entry from ${when}? This cannot be undone.`}
                          >
                            <input type="hidden" name="id" value={point.id} />
                            <SubmitButton
                              variant="ghost"
                              size="xs"
                              aria-label={`Delete weight entry from ${when}`}
                            >
                              Delete
                            </SubmitButton>
                          </ActionForm>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {history.length > table.length ? (
          <p className="text-xs text-muted-foreground">Showing the newest {table.length} of {history.length} points.</p>
        ) : null}
      </section>
    </div>
  );
}
