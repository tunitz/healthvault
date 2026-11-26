/**
 * Regression: hours-asleep averages must exclude Apple sleep codes 1 (InBed) and 3 (Awake).
 * `sleepSummary()` in src/db/queries.ts counts only ASLEEP codes 2,4,5,6; the stacked chart
 * used to include Awake in its average, reporting several extra hours per night. These tests
 * exercise the same `sleepStageSummary()` the chart renders with synthetic stage rows.
 */
import { describe, expect, test } from "bun:test";
import { sleepStageSummary, type SleepStageRow } from "@/components/sleep-stack-chart";

const row = (day: string, stage: number, hours: number): SleepStageRow => ({ day, stage, hours });

describe("sleepStageSummary", () => {
  test("average excludes Awake (3) and InBed (1), counting only 2/4/5/6", () => {
    const data = [
      row("2026-11-01", 1, 8), // InBed — superset, excluded
      row("2026-11-01", 2, 6), // Asleep
      row("2026-11-01", 3, 2), // Awake — excluded
      row("2026-11-01", 4, 1), // Core
      row("2026-11-01", 5, 1), // Deep
      row("2026-11-01", 6, 1), // REM
      row("2026-11-02", 2, 7), // Asleep
      row("2026-11-02", 3, 3), // Awake — excluded
    ];
    const { rows, present, avgHours, nightCount } = sleepStageSummary(data);

    // Night 1 asleep = 6 + 1 + 1 + 1 = 9; night 2 asleep = 7. Average = 8, not 10.5
    // (which is what including Awake would give).
    expect(avgHours).toBe(8);
    expect(nightCount).toBe(2);
    expect(rows[0].asleep).toBe(6);
    expect(rows[0].awake).toBe(2);
    // Awake is still shown in the stacked view even though it is not counted as asleep.
    expect(present).toContain("awake");
  });

  test("a night with only Awake contributes nothing and does not enter the denominator", () => {
    const { avgHours, nightCount, rows } = sleepStageSummary([
      row("2026-11-01", 2, 8),
      row("2026-11-02", 3, 4), // Awake-only night
    ]);
    expect(avgHours).toBe(8);
    expect(nightCount).toBe(1);
    expect(rows).toHaveLength(2); // still rendered as a night in the chart
  });

  test("empty input yields no nights and a zero average", () => {
    expect(sleepStageSummary([])).toMatchObject({ avgHours: 0, nightCount: 0, present: [] });
  });
});
