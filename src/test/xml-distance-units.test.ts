import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-xml-distance-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

let allWorkouts: typeof import("@/db/queries").allWorkouts;

const distanceStat = (sum: string, unit?: string) =>
  `<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="${sum}"${unit ? ` unit="${unit}"` : ""}/>`;

const workout = (sourceName: string, day: number, attributes = "", statistics = "") => {
  const date = `2026-01-${String(day).padStart(2, "0")}`;
  return `<Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="${sourceName}" ` +
    `startDate="${date} 06:00:00 +0800" endDate="${date} 06:30:00 +0800" duration="30" durationUnit="min" ${attributes}>` +
    `${statistics}</Workout>`;
};

beforeAll(async () => {
  const { runIngest } = await import("@/lib/ingest");
  ({ allWorkouts } = await import("@/db/queries"));

  const xml = `<?xml version="1.0" encoding="UTF-8"?><HealthData>${[
    workout("unsupported-stat", 1, "", distanceStat("5", "furlong")),
    workout("missing-stat-unit", 2, "", distanceStat("5000")),
    workout("unsupported-attribute", 3, `totalDistance="5" totalDistanceUnit="furlong"`),
    workout("missing-attribute-unit", 4, `totalDistance="5000"`),
    workout("known-mile", 5, "", distanceStat("3.106856", "mi")),
  ].join("")}</HealthData>`;
  const zip = zipSync({ "apple_health_export/export.xml": strToU8(xml) });
  await runIngest(zip, "xml-distance-units.zip", zip.length);
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

import { parseHealthXml, toKcal } from "@/lib/xml";

describe("energy and numeric XML parsing", () => {
  test("toKcal distinguishes Cal (kcal), cal (small calorie), kcal, and kJ", () => {
    expect(toKcal(500, "Cal")).toBe(500);
    expect(toKcal(500, "kcal")).toBe(500);
    expect(toKcal(500, "KCAL")).toBe(500);
    expect(toKcal(500, "cal")).toBeCloseTo(0.5, 6);
    expect(toKcal(1000, "kJ")).toBeCloseTo(239.0057, 4);
    expect(toKcal(500, undefined)).toBe(500);
  });

  test("num() guards NaN/Infinity and ActivitySummary normalises energy units", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><HealthData>
      <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="not-a-number" startDate="2026-01-01 07:00:00 +0800" endDate="2026-01-01 07:00:00 +0800" sourceName="Scale"/>
      <ActivitySummary dateComponents="2026-01-01" activeEnergyBurned="1000" activeEnergyBurnedGoal="2000" activeEnergyBurnedUnit="kJ" appleExerciseTime="30" appleStandHours="10"/>
      <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="450" activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="Cal"/>
    </HealthData>`;
    const parsed = parseHealthXml(xml);
    expect(parsed.records[0].value).toBe(0);
    expect(Number.isFinite(parsed.records[0].value)).toBe(true);
    expect(parsed.summaries[0].activeEnergyBurned).toBeCloseTo(239.0057, 4);
    expect(parsed.summaries[0].activeEnergyBurnedGoal).toBeCloseTo(478.0114, 4);
    expect(parsed.summaries[1].activeEnergyBurned).toBe(450);
    expect(parsed.summaries[1].activeEnergyBurnedGoal).toBe(600);
  });
});

describe("workout distances ingested from XML", () => {
  test("unsupported units are preserved and missing units are not assumed to be kilometres", () => {
    const bySource = new Map(allWorkouts({ limit: 10 }).map((row) => [row.sourceName, row]));

    for (const sourceName of ["unsupported-stat", "unsupported-attribute"]) {
      expect(bySource.get(sourceName)).toMatchObject({
        totalDistance: 5,
        totalDistanceUnit: "furlong",
        distanceKm: null,
      });
    }

    for (const sourceName of ["missing-stat-unit", "missing-attribute-unit"]) {
      expect(bySource.get(sourceName)).toMatchObject({
        totalDistance: null,
        totalDistanceUnit: null,
        distanceKm: null,
      });
    }

    expect(bySource.get("known-mile")?.distanceKm).toBeCloseTo(5, 5);
    expect(bySource.get("known-mile")?.totalDistanceUnit).toBe("km");
  });
});
