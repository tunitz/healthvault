/**
 * Pure helpers behind the dashboard's three correctness fixes. Kept free of database imports so
 * they can be unit-tested directly.
 */

export type ChecklistShape = {
  taken: number;
  total: number;
  items: readonly { logged: boolean; schedule?: { time: string | null } }[];
};

/** Supplements scheduled today that are still untaken — NOT just those already due. */
export function remainingDueCount(items: readonly { logged: boolean }[]): number {
  return items.filter((item) => !item.logged).length;
}

/**
 * Correct "All taken" hint. `nextSupplement` only returns items already due, so a null `next`
 * does not mean everything is taken — a later-timed or untimed supplement can still be pending.
 */
export function supplementHint(
  checklist: ChecklistShape,
  nextLabel: string | null = null,
): string {
  if (checklist.total === 0) return "None scheduled";
  if (checklist.taken === checklist.total) return "All taken";
  if (nextLabel) return `Next: ${nextLabel}`;
  const remaining = remainingDueCount(checklist.items);
  return `${remaining} remaining today`;
}

/**
 * Show Apple-import onboarding only when there is genuinely nothing to display. Manual nutrition,
 * measurements, supplement logs and prior imports are all legitimate dashboard content even when
 * no record rows were ever imported.
 */
export function hasDashboardContent(input: {
  records: number;
  nutritionEntries: number;
  latestMeasurement: boolean;
  supplementLogs: number;
  supplementsScheduled: number;
  uploads: number;
}): boolean {
  return (
    input.records > 0 ||
    input.nutritionEntries > 0 ||
    input.latestMeasurement ||
    input.supplementLogs > 0 ||
    input.supplementsScheduled > 0 ||
    input.uploads > 0
  );
}

export type UploadAttempt = {
  status: string;
  filename: string;
  finishedAtMs: number | null;
  inserted: number;
  createdAtMs: number;
};

/**
 * The most recent SUCCESSFUL import, not merely the most recent attempt. A newer failed or
 * still-running import must not hide an earlier completed one.
 */
export function lastSuccessfulUpload(attempts: readonly UploadAttempt[]): UploadAttempt | null {
  return attempts.find((attempt) => attempt.status === "done") ?? null;
}

/** Asleep stages only: InBed (1) is a superset and Awake (3) is not sleep. */
export function asleepHoursByNight(
  rows: readonly { day: string; stage: number; hours: number }[],
): { day: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.stage !== 2 && row.stage !== 4 && row.stage !== 5 && row.stage !== 6) continue;
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.hours);
  }
  return [...byDay.entries()]
    .map(([day, value]) => ({ day, value: Number(value.toFixed(2)) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
