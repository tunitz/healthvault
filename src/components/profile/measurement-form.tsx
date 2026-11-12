"use client";

import { useState } from "react";
import { addMeasurementAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { waistUnit, weightUnit, type Units } from "@/lib/units";

const SELECT =
  "h-8 max-sm:h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const KIND_LABEL: Record<string, { value: string; unit?: string[] }> = {
  weight: { value: "Weight", unit: ["kg", "lb"] },
  bodyFat: { value: "Body fat (%)" },
  waist: { value: "Waist", unit: ["cm", "in"] },
};

export function MeasurementForm({
  today,
  defaultTime,
  units,
}: {
  today: string;
  defaultTime: string;
  units: Units;
}) {
  const [kind, setKind] = useState<keyof typeof KIND_LABEL>("weight");
  const meta = KIND_LABEL[kind];
  const preferredUnit =
    kind === "weight" ? weightUnit(units) : kind === "waist" ? waistUnit(units) : meta.unit?.[0];
  const placeholder =
    kind === "weight" ? (units === "imperial" ? "176" : "80") : kind === "bodyFat" ? "20" : units === "imperial" ? "35" : "90";

  return (
    <ActionForm action={addMeasurementAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
      <Field label="Kind">
        <select name="kind" value={kind} onChange={(event) => setKind(event.target.value as keyof typeof KIND_LABEL)} className={SELECT}>
          <option value="weight">Weight</option>
          <option value="bodyFat">Body fat</option>
          <option value="waist">Waist</option>
        </select>
      </Field>

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label={meta.value}>
          <Input name="value" type="number" inputMode="decimal" step="0.1" min="0" required placeholder={placeholder} />
        </Field>
        {meta.unit ? (
          <Field label="Unit">
            <select key={kind} name="unit" defaultValue={preferredUnit} className={SELECT}>
              {meta.unit.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>

      <Field label="Day">
        <Input name="day" type="date" defaultValue={today} />
      </Field>

      <Field label="Time" hint="Local time">
        <Input name="time" type="time" defaultValue={defaultTime} />
      </Field>

      <Field label="Note" className="sm:col-span-2">
        <Input name="note" placeholder="Optional" maxLength={1000} />
      </Field>

      <div className="sm:col-span-2 flex justify-end">
        <SubmitButton>Add measurement</SubmitButton>
      </div>
    </ActionForm>
  );
}
