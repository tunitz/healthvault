"use client";

import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { saveProfileAction, saveWorkScheduleAction } from "@/app/actions";
import { formatSeconds } from "@/lib/format";
import { formatHeight, type Units } from "@/lib/units";
import type { Profile } from "@/lib/services/profile";

const SELECT =
  "h-8 max-sm:h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";
/** 16 px on phones so iOS Safari does not zoom the page when the field is focused. */
const AREA =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function ProfileForm({
  profile,
  age,
  units,
  goalSeconds,
}: {
  profile: Profile;
  age: number | null;
  units: Units;
  goalSeconds: number;
}) {
  return (
    <ActionForm action={saveProfileAction} className="grid gap-4 sm:grid-cols-2">
      <Field label="Name">
        <Input name="name" defaultValue={profile.name ?? ""} autoComplete="name" />
      </Field>

      <Field label="Date of birth" hint={age === null ? "Used for age-based suggestions" : `${age} years old`}>
        <Input name="birthDate" type="date" defaultValue={profile.birthDate ?? ""} max={new Date().toISOString().slice(0, 10)} />
      </Field>

      <Field label="Sex">
        <select name="sex" defaultValue={profile.sex ?? ""} className={SELECT}>
          <option value="">Not set</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="other">Other</option>
        </select>
      </Field>

      <Field
        label="Height (cm)"
        hint={
          profile.heightCm && units === "imperial"
            ? `Shown as ${formatHeight(profile.heightCm, units)}`
            : "Used for suggestions"
        }
      >
        <Input name="heightCm" type="number" inputMode="decimal" step="0.1" min="50" max="260" defaultValue={profile.heightCm ?? ""} />
      </Field>

      <Field label="Timezone" hint="IANA name, e.g. Asia/Shanghai">
        <Input name="timezone" defaultValue={profile.timezone} autoComplete="off" spellCheck={false} />
      </Field>

      <Field label="Units">
        <select name="units" defaultValue={profile.units} className={SELECT}>
          <option value="metric">Metric (kg, cm)</option>
          <option value="imperial">Imperial (lb, in)</option>
        </select>
      </Field>

      <Field label="Goal weight (kg)">
        <Input name="goalWeightKg" type="number" inputMode="decimal" step="0.1" min="20" max="400" defaultValue={profile.goalWeightKg ?? ""} />
      </Field>

      <Field label="5K goal time" hint="mm:ss — target pace is derived">
        <Input
          name="goalTime"
          pattern="[0-9]{1,3}:[0-5][0-9]"
          placeholder="30:00"
          defaultValue={formatSeconds(goalSeconds)}
        />
      </Field>

      <div className="sm:col-span-2 grid gap-4">
        <details className="rounded-xl border border-border" open={Boolean(profile.goalsNote || profile.dietNote || profile.activityNote)}>
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Notes</summary>
          <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-3">
            <Field label="Goals">
              <textarea name="goalsNote" className={AREA} defaultValue={profile.goalsNote ?? ""} />
            </Field>
            <Field label="Diet">
              <textarea name="dietNote" className={AREA} defaultValue={profile.dietNote ?? ""} />
            </Field>
            <Field label="Activity">
              <textarea name="activityNote" className={AREA} defaultValue={profile.activityNote ?? ""} />
            </Field>
          </div>
        </details>
      </div>

      <div className="sm:col-span-2 flex justify-end">
        <SubmitButton>Save profile</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function WorkScheduleForm({
  schedule,
}: {
  schedule: { days: { weekday: number; start: string; end: string }[]; note?: string };
}) {
  const byDay = new Map(schedule.days.map((day) => [day.weekday, day]));
  return (
    <ActionForm action={saveWorkScheduleAction} className="flex flex-col gap-3">
      <div className="flex flex-col divide-y divide-border">
        {WEEKDAYS.map((label, weekday) => {
          const entry = byDay.get(weekday);
          return (
            <div key={weekday} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
              <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0 sm:w-28">
                <input
                  type="checkbox"
                  name={`enabled-${weekday}`}
                  defaultChecked={Boolean(entry)}
                  aria-label={label}
                  className="size-4 accent-[var(--primary)]"
                />
                <span>{label}</span>
              </label>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none">
                <Input
                  type="time"
                  name={`start-${weekday}`}
                  defaultValue={entry?.start ?? "09:00"}
                  aria-label={`${label} start`}
                  className="min-w-[8rem] flex-1 px-2.5 tabular-nums max-sm:h-11 sm:w-36 sm:flex-none"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="time"
                  name={`end-${weekday}`}
                  defaultValue={entry?.end ?? "17:00"}
                  aria-label={`${label} end`}
                  className="min-w-[8rem] flex-1 px-2.5 tabular-nums max-sm:h-11 sm:w-36 sm:flex-none"
                />
              </div>
            </div>
          );
        })}
      </div>
      <Field label="Schedule note">
        <Input name="scheduleNote" defaultValue={schedule.note ?? ""} placeholder="Optional" />
      </Field>
      <div className="flex justify-end">
        <SubmitButton>Save schedule</SubmitButton>
      </div>
    </ActionForm>
  );
}
