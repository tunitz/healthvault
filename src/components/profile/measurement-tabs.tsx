"use client";

import { useState } from "react";
import { deleteMeasurementAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { WeightChart } from "@/components/profile/weight-chart";
import { Badge } from "@/components/ui/badge";
import { formatLocal } from "@/lib/day";
import { num } from "@/lib/format";
import type { MeasurementKind, Point } from "@/lib/services/measurements";
import { formatWaist, formatWeight, type Units } from "@/lib/units";
import { cn } from "@/lib/utils";

const TABS: { kind: MeasurementKind; label: string }[] = [
  { kind: "weight", label: "Weight" },
  { kind: "bodyFat", label: "Body fat" },
  { kind: "waist", label: "Waist" },
];

function formatPointValue(point: Point, kind: MeasurementKind, units: Units): string {
  if (kind === "weight") return formatWeight(point.value, units);
  if (kind === "waist") return formatWaist(point.value, units);
  return `${num(point.value, 1)} %`;
}

export function MeasurementTabs({
  weight,
  bodyFat,
  waist,
  goalKg,
  timezone,
  units,
}: {
  weight: Point[];
  bodyFat: Point[];
  waist: Point[];
  goalKg: number | null;
  timezone: string;
  units: Units;
}) {
  const [kind, setKind] = useState<MeasurementKind>("weight");

  const points = kind === "weight" ? weight : kind === "bodyFat" ? bodyFat : waist;
  const table = [...points].reverse().slice(0, 60);
  const label = kind === "weight" ? "Weight" : kind === "bodyFat" ? "Body fat" : "Waist";

  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label="Measurement metric" className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        {TABS.map((tab) => {
          const count = tab.kind === "weight" ? weight.length : tab.kind === "bodyFat" ? bodyFat.length : waist.length;
          return (
            <button
              key={tab.kind}
              type="button"
              role="tab"
              aria-selected={kind === tab.kind}
              onClick={() => setKind(tab.kind)}
              className={cn(
                "min-h-10 rounded-lg px-3 text-sm font-medium transition-colors sm:min-h-8",
                kind === tab.kind
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {tab.label} <span className="num opacity-75">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-border p-4">
        {kind === "weight" ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-[var(--chart-1)]" /> Manual
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-[var(--chart-2)]" /> Apple
              </span>
            </div>
            <WeightChart points={weight} goalKg={goalKg} timezone={timezone} units={units} />
          </>
        ) : points.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No {label.toLowerCase()} entries logged yet.
          </p>
        ) : (
          <SeriesChart
            data={points.map((p) => ({
              day: p.day,
              value:
                kind === "waist" && units === "imperial"
                  ? Math.round((p.value / 2.54) * 10) / 10
                  : Math.round(p.value * 10) / 10,
            }))}
            kind="line"
            label={label}
            unit={kind === "bodyFat" ? "%" : units === "imperial" ? "in" : "cm"}
            colorVar={kind === "bodyFat" ? "var(--chart-3)" : "var(--chart-4)"}
            ariaLabel={`${label} trend`}
          />
        )}
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="measurement-history">
        <h2 id="measurement-history" className="text-sm font-medium">{label} log</h2>
        {table.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No {label.toLowerCase()} entries yet.</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border/60 md:hidden">
              {table.map((point) => {
                const when = formatLocal(point.takenAtMs, timezone);
                return (
                  <li key={`${kind}-${point.source}-${point.takenAtMs}`} className="flex flex-col gap-1 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="num text-sm">{formatPointValue(point, kind, units)}</p>
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
                        confirm={`Delete the ${label.toLowerCase()} entry from ${when}? This cannot be undone.`}
                      >
                        <input type="hidden" name="id" value={point.id} />
                        <SubmitButton
                          variant="ghost"
                          size="xs"
                          aria-label={`Delete ${label.toLowerCase()} entry from ${when}`}
                        >
                          Delete
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">{label}</th>
                    <th className="py-2 pr-3 font-medium">Source</th>
                    <th className="py-2 pr-3 font-medium">Note</th>
                    <th className="py-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((point) => {
                    const when = formatLocal(point.takenAtMs, timezone);
                    return (
                      <tr key={`${kind}-${point.source}-${point.takenAtMs}`} className="border-b border-border/60">
                        <td className="num py-2 pr-3 text-muted-foreground">{when}</td>
                        <td className="num py-2 pr-3">{formatPointValue(point, kind, units)}</td>
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
                              confirm={`Delete the ${label.toLowerCase()} entry from ${when}? This cannot be undone.`}
                            >
                              <input type="hidden" name="id" value={point.id} />
                              <SubmitButton
                                variant="ghost"
                                size="xs"
                                aria-label={`Delete ${label.toLowerCase()} entry from ${when}`}
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
                  })}
                </tbody>
              </table>
            </div>
            {points.length > table.length ? (
              <p className="text-xs text-muted-foreground">
                Showing the newest {table.length} of {points.length} points.
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
