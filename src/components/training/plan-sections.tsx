import Link from "next/link";
import { ActionForm, Field, SubmitButton } from "@/components/action-form";
import { PaceGoalChart } from "@/components/training-charts";
import { SessionUpdate } from "@/components/training/session-update";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { startTrainingBlockAction } from "@/app/actions";
import type { FiveKAttempt } from "@/db/queries";
import { dayLabel } from "@/lib/day";
import { formatSeconds, plural, workoutLabel } from "@/lib/format";
import type { TrainingGoal } from "@/lib/services/profile";
import {
  sessionTarget,
  type BlockState,
  type PlannedSession,
} from "@/lib/services/training-plan";
import { formatDistance, formatPaceClock, toDisplayPace, type Units } from "@/lib/units";

export type WorkoutOption = {
  id: number;
  type: string;
  minutes: number | null;
  km: number | null;
};

function Fact({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="num text-lg font-semibold tracking-tight">{value}</p>
      {hint ? <p className="break-words text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function intentLabel(intent: string | null): string {
  return intent ? intent.replaceAll("_", " ") : "—";
}

/** The north-star target is always shown, even before any attempt exists. */
export function FiveKGoalSection({
  goal,
  attempts,
  best,
  units,
}: {
  goal: TrainingGoal;
  attempts: FiveKAttempt[];
  best: FiveKAttempt | null;
  units: Units;
}) {
  const paceGap =
    best === null
      ? null
      : toDisplayPace(best.paceMinPerKm, units) - toDisplayPace(goal.targetPaceMinPerKm, units);
  const gapValue = paceGap === null ? "—" : paceGap <= 0 ? "goal met" : `+${formatSeconds(paceGap * 60)}`;
  const gapHint =
    paceGap === null
      ? "No attempt yet"
      : paceGap <= 0
        ? "Best pace is at or under the target"
        : `per ${units === "imperial" ? "mile" : "km"} over goal pace`;
  const newestFirst = [...attempts].reverse();
  const shown = newestFirst.slice(0, 50);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="five-k-title">
      <div className="flex flex-col gap-0.5">
        <h2 id="five-k-title" className="text-sm font-medium">5K goal</h2>
        <p className="text-xs text-muted-foreground">
          Target sub-{formatSeconds(goal.targetSeconds)} · {formatPaceClock(goal.targetPaceMinPerKm, units)}
          {goal.configured ? "" : " (default)"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact
          title="Goal"
          value={`sub-${formatSeconds(goal.targetSeconds)}`}
          hint={formatPaceClock(goal.targetPaceMinPerKm, units)}
        />
        <Fact
          title="Best attempt"
          value={best === null ? "—" : formatSeconds(best.seconds)}
          hint={
            best === null
              ? "No 5 km attempt in the last year"
              : `${formatDistance(best.km, units, 2)} · ${formatPaceClock(best.paceMinPerKm, units)} · ${dayLabel(best.day)}`
          }
        />
        <Fact title="Gap to goal" value={gapValue} hint={gapHint} />
        <Fact
          title="Attempts (365 d)"
          value={plural(attempts.length, "attempt")}
          hint="4.9–5.5 km runs, one row per session"
        />
      </div>

      {attempts.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No 5 km attempts in the last year. Imported runs between 4.9 and 5.5 km appear here.
        </p>
      ) : (
        <>
          <PaceGoalChart attempts={attempts} goalPaceMinPerKm={goal.targetPaceMinPerKm} units={units} />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Distance</TableHead>
                <TableHead className="text-right">Pace</TableHead>
                <TableHead className="text-right">Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((attempt, index) => {
                const delta =
                  toDisplayPace(attempt.paceMinPerKm, units) - toDisplayPace(goal.targetPaceMinPerKm, units);
                return (
                  <TableRow key={`${attempt.day}-${index}`}>
                    <TableCell className="num">
                      <span className="sm:hidden">{attempt.day.slice(5)}</span>
                      <span className="hidden sm:inline">{attempt.day}</span>
                    </TableCell>
                    <TableCell className="num text-right">{formatSeconds(attempt.seconds)}</TableCell>
                    <TableCell className="num hidden text-right sm:table-cell">
                      {formatDistance(attempt.km, units, 2)}
                    </TableCell>
                    <TableCell className="num text-right">{formatPaceClock(attempt.paceMinPerKm, units)}</TableCell>
                    <TableCell className="num text-right">
                      {delta === 0 ? "—" : `${delta > 0 ? "+" : "-"}${formatSeconds(Math.abs(delta) * 60)}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {newestFirst.length > shown.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the newest {shown.length} of {plural(newestFirst.length, "attempt")}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function SessionRow({
  session,
  options,
  units,
}: {
  session: PlannedSession;
  options: WorkoutOption[];
  units: Units;
}) {
  const target = sessionTarget(session);
  const linked = session.workoutId === null ? undefined : options.find((option) => option.id === session.workoutId);

  return (
    <li className="flex flex-col gap-2 border-t border-border/60 py-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span>{session.title}</span>
          <Badge variant="outline">{intentLabel(session.intent)}</Badge>
          <Badge variant={session.status === "done" ? "default" : "secondary"}>{session.status}</Badge>
        </p>
        <p className="num text-xs text-muted-foreground">
          {dayLabel(session.day)} · {session.day}
        </p>
        {target ? <p className="text-xs text-muted-foreground">{target.structure}</p> : null}
        {session.note ? <p className="text-xs text-muted-foreground">{session.note}</p> : null}
        {session.status === "done" ? (
          <p className="text-xs text-muted-foreground">
            {linked
              ? `Linked: ${workoutLabel(linked.type)} · ${formatDistance(linked.km, units, 2)}${
                  linked.minutes === null ? "" : ` · ${Math.round(linked.minutes)} min`
                }`
              : "No imported workout linked"}
          </p>
        ) : null}
      </div>

      <SessionUpdate
        session={session}
        options={options}
        units={units}
        dayLabel={dayLabel(session.day)}
      />
    </li>
  );
}

/** Start form + current week + the collapsible 16-week outline. */
export function TrainingBlockSection({
  block,
  defaultStart,
  workoutOptions,
  units,
}: {
  block: BlockState | null;
  defaultStart: string;
  workoutOptions: Record<string, WorkoutOption[]>;
  units: Units;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="training-block-title">
      <div className="flex flex-col gap-0.5">
        <h2 id="training-block-title" className="text-sm font-medium">Training block</h2>
        <p className="text-xs text-muted-foreground">
          Planned sessions are intent only — they never count as distance, time or calories.
        </p>
      </div>

      {block !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            <span className="font-medium">Week {block.currentWeekNo} of {block.totalWeeks}</span>
            <span className="text-muted-foreground"> · {dayLabel(block.weekStart)} – {dayLabel(block.weekEnd)}</span>
            {block.finished ? <Badge variant="outline" className="ml-2">complete</Badge> : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {block.sessions.filter((session) => session.status === "done").length} done ·{" "}
            {block.sessions.filter((session) => session.status === "skipped").length} skipped ·{" "}
            {block.sessions.filter((session) => session.status === "planned").length} planned
          </p>
        </div>
      ) : null}

      {block === null || block.finished ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <p className="text-sm">
            {block === null ? "Start the 16-week 5K block." : "Block complete. Start another when recovery allows."}
          </p>
          <ActionForm action={startTrainingBlockAction} className="flex flex-wrap items-end gap-3">
            <Field label="Start date" hint="Must be a Monday" className="w-full sm:w-auto">
              <Input
                name="startDate"
                type="date"
                required
                defaultValue={defaultStart}
                className="w-full sm:w-44"
              />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="includeStrength"
                className="size-4 accent-[var(--primary)]"
              />
              Include Tue/Fri strength
            </label>
            <SubmitButton>Start block</SubmitButton>
          </ActionForm>
          <p className="text-xs text-muted-foreground">
            Adjust by recovery rather than a promised deadline; repeat a block if the target pace is not
            controlled.
          </p>
        </div>
      ) : null}

      {block !== null ? (
        <>
          <div className="rounded-xl border border-border px-4">
            <h3 className="pt-3 text-xs font-medium text-muted-foreground">This week</h3>
            {block.thisWeek.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No sessions scheduled this week.</p>
            ) : (
              <ul className="flex flex-col">
                {block.thisWeek.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    options={workoutOptions[session.day] ?? []}
                    units={units}
                  />
                ))}
              </ul>
            )}
          </div>

          <details className="rounded-xl border border-border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              Full 16-week outline
            </summary>
            <div className="flex flex-col border-t border-border">
              {block.weeks.map((week) => (
                <details key={week.weekNo} className="border-t border-border first:border-t-0" open={week.weekNo === block.currentWeekNo}>
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <span>
                      Week {week.weekNo}
                      <span className="text-muted-foreground"> · {dayLabel(week.start)} – {dayLabel(week.end)}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {week.done}/{week.total} done{week.skipped ? ` · ${week.skipped} skipped` : ""}
                    </span>
                  </summary>
                  <ul className="flex flex-col gap-2 px-4 pb-3">
                    {week.sessions.map((session) => {
                      const target = sessionTarget(session);
                      return (
                        <li key={session.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span className="num w-10 shrink-0 text-muted-foreground">{session.day.slice(5)}</span>
                          <span className="font-medium">{session.title}</span>
                          <Badge variant="outline">{intentLabel(session.intent)}</Badge>
                          {target ? <span className="min-w-0 text-muted-foreground">{target.structure}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ))}
            </div>
          </details>
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">
        The imported workout stays the single source of what was run; a link never changes its totals.{" "}
        <Link className="text-primary underline underline-offset-4" href="/profile">Edit the 5K goal</Link>.
      </p>
    </section>
  );
}
