"use client";

import { useState } from "react";
import { setSessionStatusAction } from "@/app/actions";
import { ActionForm, Field } from "@/components/action-form";
import { LogDialog } from "@/components/log-dialog";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { workoutLabel } from "@/lib/format";
import { formatDistance, type Units } from "@/lib/units";

type Session = {
  id: number;
  title: string;
  day: string;
  status: string;
  workoutId: number | null;
};

type Option = {
  id: number;
  type: string;
  minutes: number | null;
  km: number | null;
};

const SELECT =
  "h-8 max-sm:h-11 min-w-0 max-w-full rounded-lg border border-input bg-transparent px-2 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/** Status and workout link for one planned session, recorded in a popup. */
export function SessionUpdate({
  session,
  options,
  units,
  dayLabel,
}: {
  session: Session;
  options: Option[];
  units: Units;
  dayLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const linked = options.find((option) => option.id === session.workoutId);

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Update ${session.title} on ${session.day}`}
      >
        Update session
      </Button>
      <LogDialog
        open={open}
        onOpenChange={setOpen}
        title={session.title}
        description={`${session.day} · ${dayLabel} · currently ${session.status}`}
        size="sm"
        footer={
          <>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" form={`session-form-${session.id}`}>Save session</Button>
          </>
        }
      >
        <ActionForm
          id={`session-form-${session.id}`}
          action={setSessionStatusAction}
          onSuccess={() => setOpen(false)}
          className="grid gap-3"
        >
          <input type="hidden" name="id" value={session.id} />
          <Field label="Status">
            <select name="status" defaultValue={session.status} className={SELECT}>
              <option value="planned">Planned</option>
              <option value="done">Done</option>
              <option value="skipped">Skipped</option>
            </select>
          </Field>
          {options.length > 0 ? (
            <Field label="Imported workout" hint="Optional · same day only">
              <select
                name="workoutId"
                defaultValue={linked?.id ?? ""}
                className={SELECT}
              >
                <option value="">No workout link</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {workoutLabel(option.type)}
                    {option.km === null ? "" : ` · ${formatDistance(option.km, units, 2)}`}
                    {option.minutes === null ? "" : ` · ${Math.round(option.minutes)} min`}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </ActionForm>
      </LogDialog>
    </div>
  );
}
