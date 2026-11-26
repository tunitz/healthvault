/**
 * Weekly supplement adherence on a scratch database.
 *
 * Covers the Sunday-start week windows, schedule-derived denominators, the current week's
 * elapsed-only percentage, separate rows for separate regimens (the two magnesium doses are
 * never merged), archived rows staying visible with their schedule, and cap/default handling.
 * Never reads real health data and never opens `data/health.db`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-adherence-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";

let supplements: typeof import("@/lib/services/supplements");
let profileService: typeof import("@/lib/services/profile");
let day: typeof import("@/lib/day");
let sqlite: import("better-sqlite3").Database;

let today = "";
let currentStart = "";

function addSupplement(
  name: string,
  options: { dose?: number; unit?: string; days?: number[] | null; time?: string | null } = {},
) {
  return supplements.createSupplement({
    name,
    dose: options.dose ?? 1,
    unit: options.unit ?? "capsule",
    schedule: { time: options.time ?? null, days: options.days ?? null },
  });
}

function rowFor(items: ReturnType<typeof supplements.weeklyAdherence>, id: number) {
  const row = items.find((item) => item.supplementId === id);
  if (!row) throw new Error(`no adherence row for supplement ${id}`);
  return row;
}

beforeAll(async () => {
  supplements = await import("@/lib/services/supplements");
  profileService = await import("@/lib/services/profile");
  day = await import("@/lib/day");
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
  today = day.localDay(Date.now(), TZ);
  currentStart = day.weekStart(today);
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM supplement_logs").run();
  sqlite.prepare("DELETE FROM supplements").run();
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("weeklyAdherence", () => {
  test("keeps the two magnesium rows separate and buckets Sunday-start weeks", () => {
    const glycinate = addSupplement("Magnesium glycinate", {
      dose: 450,
      unit: "mg",
      days: [0, 1, 2, 3, 4, 5, 6],
      time: "21:00",
    });
    const citrate = addSupplement("Magnesium citrate", {
      dose: 200,
      unit: "mg",
      days: [0, 1, 2, 3, 4, 5, 6],
      time: "21:00",
    });

    const lastWeek = day.addDays(currentStart, -7);
    supplements.logSupplement({ supplementId: glycinate.id, day: lastWeek, taken: true });
    supplements.logSupplement({ supplementId: glycinate.id, day: day.addDays(lastWeek, 1), taken: true });
    supplements.logSupplement({ supplementId: glycinate.id, day: today, taken: true });

    const rows = supplements.weeklyAdherence(2);
    expect(rows.filter((row) => [glycinate.id, citrate.id].includes(row.supplementId))).toHaveLength(2);

    const gly = rowFor(rows, glycinate.id);
    expect(gly.name).toBe("Magnesium glycinate");
    expect(gly.dose).toBe(450);
    expect(gly.unit).toBe("mg");
    expect(gly.weeks).toHaveLength(2);

    const previous = gly.weeks[0];
    expect(previous.weekStart).toBe(lastWeek);
    expect(previous.weekEnd).toBe(day.addDays(lastWeek, 6));
    expect(previous.scheduledDays).toBe(7);
    expect(previous.takenDays).toBe(2);
    expect(previous.pct).toBe(29); // 2/7 rounded
    expect(previous.days).toHaveLength(7);
    expect(previous.days.every((entry) => entry.scheduled)).toBe(true);
    expect(previous.days.every((entry) => entry.future)).toBe(false);

    const current = gly.weeks[1];
    expect(current.weekStart).toBe(currentStart);
    expect(current.days.find((entry) => entry.day === today)?.taken).toBe(true);
    expect(current.pct).toBe(Math.round((1 / 7) * 100));

    // The current week's percentage counts only days that have already happened.
    const elapsed = day.weekdayIndex(today) + 1;
    expect(current.elapsedScheduledDays).toBe(elapsed);
    expect(current.elapsedTakenDays).toBe(1);
    expect(current.elapsedPct).toBe(Math.round((1 / elapsed) * 100));
    expect(current.days.filter((entry) => entry.future)).toHaveLength(6 - day.weekdayIndex(today));

    const cit = rowFor(rows, citrate.id);
    expect(cit.weeks[1].takenDays).toBe(0);
    expect(cit.weeks[1].elapsedTakenDays).toBe(0);
    expect(cit.weeks[1].elapsedPct).toBe(0);
  });

  test("uses the regimen's day list as the denominator and ignores extra doses", () => {
    const vitaminD = addSupplement("Vitamin D3", { days: [1, 3, 5] });
    // A Sunday dose (not scheduled) must not inflate adherence.
    supplements.logSupplement({ supplementId: vitaminD.id, day: currentStart, taken: true });

    const week = rowFor(supplements.weeklyAdherence(1), vitaminD.id).weeks[0];
    expect(week.scheduledDays).toBe(3);
    expect(week.takenDays).toBe(0);
    expect(week.pct).toBe(0);
    expect(week.days.filter((entry) => entry.scheduled).map((entry) => entry.day)).toEqual([
      day.addDays(currentStart, 1),
      day.addDays(currentStart, 3),
      day.addDays(currentStart, 5),
    ]);
    expect(week.days.filter((entry) => entry.taken).map((entry) => entry.day)).toEqual([currentStart]);
  });

  test("a null day list means all seven days, and archived rows keep their schedule", () => {
    const creatine = addSupplement("Creatine monohydrate");
    let row = rowFor(supplements.weeklyAdherence(1), creatine.id);
    expect(row.active).toBe(true);
    expect(row.weeks[0].scheduledDays).toBe(7);

    supplements.updateSupplement(creatine.id, { active: false });
    row = rowFor(supplements.weeklyAdherence(1), creatine.id);
    expect(row.active).toBe(false);
    // Adherence history is schedule-based: an archived regimen still shows its past weeks.
    expect(row.weeks[0].scheduledDays).toBe(7);
  });

  test("defaults to four weeks and caps the requested window", () => {
    addSupplement("Zinc");
    expect(supplements.weeklyAdherence(0)[0].weeks).toHaveLength(4);
    expect(supplements.weeklyAdherence(2)[0].weeks).toHaveLength(2);
    expect(supplements.weeklyAdherence(99)[0].weeks).toHaveLength(52);
  });
});

describe("nextSupplement", () => {
  test("does not return future or untimed items and marks scheduled doses due at wall-clock time", () => {
    const morning = addSupplement("Morning dose", { time: "09:30", days: [day.weekdayIndex(today)] });
    addSupplement("Unscheduled dose", { time: null, days: [day.weekdayIndex(today)] });
    const dueAtMs = day.localTimeMs(today, "09:30", TZ);

    expect(supplements.nextSupplement(today, dueAtMs - 1)).toBeNull();
    expect(supplements.nextSupplement(today, dueAtMs)).toMatchObject({
      supplement: { id: morning.id },
      due: true,
      dueAtMs,
    });

    supplements.logSupplement({ supplementId: morning.id, day: today, taken: true });
    expect(supplements.nextSupplement(today, dueAtMs + 60_000)).toBeNull();
  });

  test("surfaces every due unchecked timed supplement in schedule order", () => {
    const weekday = day.weekdayIndex(today);
    const morning = addSupplement("Morning dose", { time: "08:00", days: [weekday] });
    const midday = addSupplement("Midday dose", { time: "12:00", days: [weekday] });
    addSupplement("Future dose", { time: "18:00", days: [weekday] });
    addSupplement("Untimed dose", { time: null, days: [weekday] });
    const checked = addSupplement("Checked dose", { time: "07:00", days: [weekday] });
    supplements.logSupplement({ supplementId: checked.id, day: today, taken: true });

    const nowMs = day.localTimeMs(today, "13:00", TZ);
    const due = supplements.dueSupplements(today, nowMs);

    expect(due.map((item) => item.supplement.id)).toEqual([morning.id, midday.id]);
    expect(due.map((item) => item.dueAtMs)).toEqual([
      day.localTimeMs(today, "08:00", TZ),
      day.localTimeMs(today, "12:00", TZ),
    ]);
    expect(due.every((item) => item.due)).toBe(true);
    expect(supplements.nextSupplement(today, nowMs)).toEqual(due[0]);
  });
});
