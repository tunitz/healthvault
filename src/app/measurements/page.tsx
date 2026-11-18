import type { Metadata } from "next";
import { deleteMeasurementAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { MeasurementForm } from "@/components/profile/measurement-form";
import { WeightChart } from "@/components/profile/weight-chart";
import { SubviewHeader } from "@/components/subviews/subview-header";
import { formatLocal, localClockNow } from "@/lib/day";
import { num } from "@/lib/format";
import { currentDay } from "@/lib/services/context";
import {
  latestMeasurement,
  measurementHistory,
  type MeasurementKind,
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

function latestText(kind: MeasurementKind, units: "metric" | "imperial"): string {
  const latest = latestMeasurement(kind);
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
  const history = measurementHistory("weight", 3650);
  const table = [...history].reverse().slice(0, 60);

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
        <div className="rounded-xl border border-border p-4">
          <MeasurementForm today={today} defaultTime={localClockNow(timezone)} units={units} />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="measurement-summary">
        <h2 id="measurement-summary" className="text-sm font-medium">Latest</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Metric label="Weight" value={latestText("weight", units)} hint={latestMeasurement("weight")?.day} />
          <Metric
            label="Goal weight"
            value={profile.goalWeightKg === null ? "—" : formatWeight(profile.goalWeightKg, units)}
            hint={profile.goalWeightKg === null ? "Not set" : "From profile"}
          />
          <Metric label="Body fat" value={latestText("bodyFat", units)} hint={latestMeasurement("bodyFat")?.day ?? "Manual only"} />
          <Metric label="Waist" value={latestText("waist", units)} hint={latestMeasurement("waist")?.day ?? "Manual only"} />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="weight-trend">
        <div className="flex flex-col gap-0.5">
          <h2 id="weight-trend" className="text-sm font-medium">Weight trend</h2>
          <p className="text-xs text-muted-foreground">Manual and Apple BodyMass entries are both shown.</p>
        </div>
        <div className="rounded-xl border border-border p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[var(--chart-1)]" /> Manual
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[var(--chart-2)]" /> Apple
            </span>
          </div>
          <WeightChart points={history} goalKg={profile.goalWeightKg} timezone={timezone} units={units} />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="measurement-history">
        <h2 id="measurement-history" className="text-sm font-medium">Weight log</h2>
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
                  {point.note ? <p className="break-words text-xs text-muted-foreground">{point.note}</p> : null}
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
                  <td colSpan={5} className="py-6 text-sm text-muted-foreground">No weight entries yet.</td>
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
                      <td className="max-w-[220px] truncate py-2 pr-3 text-muted-foreground">{point.note ?? "—"}</td>
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
