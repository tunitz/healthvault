"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { logStrengthSetsAction } from "@/app/actions";
import { Field, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ActionState } from "@/lib/action-state";
import { dayLabel } from "@/lib/day";
import { num, plural, workoutLabel } from "@/lib/format";
import type { ProgressionWeek, StrengthSession } from "@/lib/services/strength";
import { formatDistance, formatWeight, weightUnit, type Units } from "@/lib/units";

const SELECT =
  "h-8 max-sm:h-11 min-w-0 max-w-full rounded-lg border border-input bg-transparent px-2 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

export type StrengthWorkoutOption = {
  id: number;
  day: string;
  type: string;
  minutes: number | null;
  km: number | null;
};

type SetRow = { id: number };

function StrengthForm({
  today,
  units,
  exercises,
  workoutOptions,
}: {
  today: string;
  units: Units;
  exercises: string[];
  workoutOptions: StrengthWorkoutOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(logStrengthSetsAction, { ok: true });
  const [rows, setRows] = useState<SetRow[]>([{ id: 0 }]);
  const [nextId, setNextId] = useState(1);
  const [day, setDay] = useState(today);
  const formRef = useRef<HTMLFormElement>(null);

  // A successful log clears the typed values; a validation error leaves the form intact.
  useEffect(() => {
    if (!state.ok || !state.message) return;
    formRef.current?.reset();
  }, [state]);

  const dayWorkouts = workoutOptions.filter((option) => option.day === day);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Exercise" className="w-full sm:flex-1">
          <Input
            name="exercise"
            list="strength-exercises"
            required
            maxLength={120}
            autoComplete="off"
            placeholder="Bench press"
          />
          <datalist id="strength-exercises">
            {exercises.map((exercise) => (
              <option key={exercise} value={exercise} />
            ))}
          </datalist>
        </Field>
        <Field label="Day" className="w-full sm:w-40">
          <Input
            name="day"
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            required
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={row.id} className="flex flex-wrap items-end gap-2">
            <span className="num w-6 pb-2 text-xs text-muted-foreground" aria-hidden>
              {index + 1}.
            </span>
            <Field label="Reps" className="min-w-0 flex-1 sm:w-20 sm:flex-none">
              <Input
                name="reps"
                type="number"
                inputMode="numeric"
                min={0}
                max={1000}
                step="any"
                placeholder="8"
              />
            </Field>
            <Field label={`Load (${weightUnit(units)})`} className="min-w-0 flex-1 sm:w-24 sm:flex-none">
              <Input
                name="loadKg"
                type="number"
                inputMode="decimal"
                min={0}
                max={units === "imperial" ? 2204 : 1000}
                step="any"
                placeholder={units === "imperial" ? "135" : "60"}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="max-sm:size-11"
              aria-label={`Remove set ${index + 1}`}
              disabled={rows.length === 1}
              onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
            >
              <span aria-hidden>×</span>
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setRows((current) => [...current, { id: nextId }]);
              setNextId((current) => current + 1);
            }}
          >
            Add set
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Imported workout" hint="Optional · same day only" className="w-full sm:w-64">
          {/* Remounts with the day so a link from another day can never be submitted. */}
          <select key={day} name="workoutId" defaultValue="" className={SELECT}>
            <option value="">None</option>
            {dayWorkouts.map((option) => (
              <option key={option.id} value={option.id}>
                {workoutLabel(option.type)}
                {option.km === null ? "" : ` · ${formatDistance(option.km, units, 2)}`}
                {option.minutes === null ? "" : ` · ${Math.round(option.minutes)} min`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note" className="w-full sm:flex-1">
          <Input name="note" maxLength={1000} placeholder="Optional" />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton>Log sets</SubmitButton>
        {state.error ? (
          <p role="alert" className="text-xs text-destructive">
            {state.error}
          </p>
        ) : null}
        {state.ok && state.message ? (
          <p role="status" className="text-xs text-muted-foreground">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function RecentSessions({ sessions, units }: { sessions: StrengthSession[]; units: Units }) {
  if (sessions.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No strength sets logged in the last 14 days.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {sessions.map((session) => (
        <li key={session.day} className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">
              <span className="num">{session.day}</span>
              <span className="text-muted-foreground"> · {dayLabel(session.day)}</span>
            </p>
            {session.workoutIds.length > 0 ? (
              <Badge variant="outline">linked to an imported workout</Badge>
            ) : (
              <Badge variant="secondary">manual only</Badge>
            )}
          </div>

          <ul className="mt-2 flex flex-col gap-1">
            {session.exercises.map((item) => (
              <li
                key={item.exercise}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm"
              >
                <span className="min-w-0 break-words">{item.exercise}</span>
                <span className="num text-xs text-muted-foreground">
                  {plural(item.sets, "set")}
                  {item.topLoadKg === null ? "" : ` · top ${formatWeight(item.topLoadKg, units)}`}
                  {item.repsRecorded > 0 ? ` · ${num(item.reps, 0)} reps` : ""}
                  {item.weightedSets > 0 ? ` · ${formatWeight(item.volumeKg, units)} volume` : ""}
                </span>
              </li>
            ))}
          </ul>

          <details className="mt-2">
            <summary className="cursor-pointer py-3.5 text-xs font-medium text-muted-foreground sm:py-0">
              Set details
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {session.sets.map((set) => (
                <li key={set.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 break-words">
                    <span className="num text-muted-foreground">#{set.setNo}</span> {set.exercise}
                  </span>
                  <span className="num text-muted-foreground">
                    {set.reps === null ? "reps —" : `${num(set.reps, 0)} reps`}
                    {set.loadKg === null ? "" : ` · ${formatWeight(set.loadKg, units)}`}
                  </span>
                </li>
              ))}
            </ul>
            {session.sets.some((set) => set.note) ? (
              <p className="mt-2 text-xs text-muted-foreground">{session.sets.find((set) => set.note)?.note}</p>
            ) : null}
          </details>
        </li>
      ))}
    </ul>
  );
}

function Progression({
  exercises,
  selectedExercise,
  progression,
  units,
  weekOffset,
}: {
  exercises: string[];
  selectedExercise: string | null;
  progression: ProgressionWeek[];
  units: Units;
  weekOffset: number;
}) {
  const hasSets = progression.some((week) => week.sets > 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">8-week progression</h3>
          <p className="text-xs text-muted-foreground">
            Best load and reps × load volume per Sunday-start week.
          </p>
        </div>
        {/* The picker submits to the current URL, so it works on /training and /training/strength. */}
        {exercises.length > 0 ? (
          <form method="get" className="flex flex-wrap items-end gap-2">
            {weekOffset > 0 ? <input type="hidden" name="week" value={weekOffset} /> : null}
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              <span>Exercise</span>
              <select name="exercise" defaultValue={selectedExercise ?? ""} className={SELECT}>
                {exercises.map((exercise) => (
                  <option key={exercise} value={exercise}>
                    {exercise}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" size="sm" variant="outline">
              View
            </Button>
          </form>
        ) : null}
      </div>

      {selectedExercise === null ? (
        <p className="py-2 text-sm text-muted-foreground">Log a set to start an 8-week progression.</p>
      ) : !hasSets ? (
        <p className="py-2 text-sm text-muted-foreground">
          No sets for {selectedExercise} in the last 8 weeks.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Week</TableHead>
              <TableHead className="text-right">Best load</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Reps at best</TableHead>
              <TableHead className="text-right">Volume</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {progression.map((week) => (
              <TableRow key={week.weekStart}>
                <TableCell className="num">
                  <span className="sm:hidden">{week.weekStart.slice(5)}</span>
                  <span className="hidden sm:inline">{week.weekStart}</span>
                </TableCell>
                <TableCell className="num text-right">
                  {week.bestLoadKg === null ? "—" : formatWeight(week.bestLoadKg, units)}
                </TableCell>
                <TableCell className="num hidden text-right sm:table-cell">
                  {week.repsAtBest === null ? "—" : num(week.repsAtBest, 0)}
                </TableCell>
                <TableCell className="num text-right">
                  {week.weightedSets > 0 ? formatWeight(week.totalVolume, units) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function StrengthLogSection({
  today,
  units,
  sessions,
  exercises,
  selectedExercise,
  progression,
  workoutOptions,
  sessionsThisWeek,
  weekOffset,
}: {
  today: string;
  units: Units;
  sessions: StrengthSession[];
  exercises: string[];
  selectedExercise: string | null;
  progression: ProgressionWeek[];
  workoutOptions: StrengthWorkoutOption[];
  sessionsThisWeek: number;
  weekOffset: number;
}) {
  return (
    <section id="strength-log" className="flex scroll-mt-20 flex-col gap-3" aria-labelledby="strength-log-title">
      <div className="flex flex-col gap-0.5">
        <h2 id="strength-log-title" className="flex flex-wrap items-center gap-2 text-sm font-medium">
          Strength log
          <Badge variant="outline">manual detail</Badge>
        </h2>
        <p className="text-xs text-muted-foreground">
          Sets and loads attached to your training. This detail never adds a workout, distance or
          calories — an imported workout stays the only session total.
        </p>
        <p className="text-xs text-muted-foreground">{plural(sessionsThisWeek, "day")} logged this week</p>
      </div>

      <StrengthForm today={today} units={units} exercises={exercises} workoutOptions={workoutOptions} />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Recent sessions</h3>
        <RecentSessions sessions={sessions} units={units} />
      </div>

      <Progression
        exercises={exercises}
        selectedExercise={selectedExercise}
        progression={progression}
        units={units}
        weekOffset={weekOffset}
      />
    </section>
  );
}
