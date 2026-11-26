import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-phase1-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

let queries: typeof import("@/db/queries");
let context: typeof import("@/lib/services/context");
let measurements: typeof import("@/lib/services/measurements");
let profile: typeof import("@/lib/services/profile");
let sqlite: import("better-sqlite3").Database;

beforeAll(async () => {
  const { runIngest } = await import("@/lib/ingest");
  queries = await import("@/db/queries");
  context = await import("@/lib/services/context");
  measurements = await import("@/lib/services/measurements");
  profile = await import("@/lib/services/profile");
  ({ sqlite } = await import("@/db"));

  profile.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = 'Asia/Shanghai' WHERE id = 1").run();

  const today = context.currentDay();
  const xml = `<?xml version="1.0" encoding="UTF-8"?><HealthData>
    <Record type="HKQuantityTypeIdentifierHeight" unit="m" value="1.76"
      startDate="${today} 07:00:00 +0800" endDate="${today} 07:00:00 +0800" sourceName="iPhone"/>
    <Record type="HKQuantityTypeIdentifierBodyMass" unit="g" value="72500"
      startDate="${today} 07:00:00 +0800" endDate="${today} 07:00:00 +0800" sourceName="Scale"/>
    <Record type="HKQuantityTypeIdentifierBodyMass" unit="st" value="11"
      startDate="${today} 08:00:00 +0800" endDate="${today} 08:00:00 +0800" sourceName="Scale"/>
    <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" unit="Cal" value="420"
      startDate="${today} 12:00:00 +0800" endDate="${today} 12:30:00 +0800" sourceName="Watch"/>
    <Record type="HKCategoryTypeIdentifierSleepAnalysis" unit="" value="HKCategoryValueSleepAnalysisAsleepCore"
      startDate="${today} 23:00:00 +0800" endDate="${today} 23:30:00 +0800" sourceName="Apple Watch"/>
    <Record type="HKCategoryTypeIdentifierSleepAnalysis" unit="" value="HKCategoryValueSleepAnalysisAsleepCore"
      startDate="${today} 23:15:00 +0800" endDate="${today} 23:45:00 +0800" sourceName="Apple Watch"/>
    <Record type="HKCategoryTypeIdentifierSleepAnalysis" unit="" value="HKCategoryValueSleepAnalysisAsleepDeep"
      startDate="${today} 23:45:00 +0800" endDate="${today} 23:59:00 +0800" sourceName="Apple Watch"/>
    <Record type="HKCategoryTypeIdentifierSleepAnalysis" unit="" value="HKCategoryValueSleepAnalysisAsleepUnspecified"
      startDate="${today} 23:00:00 +0800" endDate="${today} 23:59:00 +0800" sourceName="iPhone"/>
  </HealthData>`;
  const zip = zipSync({ "apple_health_export/export.xml": strToU8(xml) });
  await runIngest(zip, "phase1-integrity.zip", zip.length);
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("Phase 1 data integrity fixes", () => {
  test("height in meters prefills profile in cm", () => {
    expect(profile.getProfile().heightCm).toBeCloseTo(176, 3);
  });

  test("appleWeight converts g and st to kg", () => {
    const history = measurements.measurementHistory("weight", 7);
    expect(history).toHaveLength(2);
    expect(history[0].value).toBeCloseTo(72.5, 3);
    expect(history[1].value).toBeCloseTo(11 * 6.35029318, 3);
  });

  test("metricsSeries(active_energy) falls back to records and treats Cal as kcal", () => {
    const series = context.metricsSeries("active_energy", 7);
    expect(series.points).toHaveLength(1);
    expect(series.points[0].value).toBeCloseTo(420, 3);
  });

  test("sleep deduplicates multi-source nights and merges overlapping same-stage intervals", () => {
    // Watch has staged Core [23:00-23:30] + [23:15-23:45] -> merged 45m (0.75h)
    // plus Deep [23:45-23:59] -> 14m (14/60h). Total = 59/60 h.
    // iPhone has 59m Unspecified on the same night and must NOT be added on top.
    const staged = queries.sleepByDayStage(7);
    const totalHours = staged.reduce((s, r) => s + r.hours, 0);
    expect(totalHours).toBeCloseTo(59 / 60, 4);

    const summary = queries.sleepSummary(7);
    expect(summary.nights).toBe(1);
    expect(summary.totalHours).toBeCloseTo(59 / 60, 4);

    const series = context.metricsSeries("sleep", 7);
    expect(series.points).toHaveLength(1);
    expect(series.points[0].value).toBeCloseTo(59 / 60, 4);
  });

  test("PRAGMA foreign_keys is enabled", () => {
    const fk = sqlite.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
  });

  test("resolveDefaultTimezone uses HEALTHVAULT_DEFAULT_TIMEZONE when valid and falls back to UTC", async () => {
    const { DEFAULT_TIMEZONE, resolveDefaultTimezone } = await import("@/lib/day");
    expect(DEFAULT_TIMEZONE).toBe("UTC");
    const prevHv = process.env.HEALTHVAULT_DEFAULT_TIMEZONE;
    const prevTz = process.env.TZ;
    try {
      delete process.env.HEALTHVAULT_DEFAULT_TIMEZONE;
      delete process.env.TZ;
      expect(resolveDefaultTimezone()).toBe("UTC");
      process.env.HEALTHVAULT_DEFAULT_TIMEZONE = "America/New_York";
      expect(resolveDefaultTimezone()).toBe("America/New_York");
      process.env.HEALTHVAULT_DEFAULT_TIMEZONE = "Not/A_Zone";
      expect(resolveDefaultTimezone()).toBe("UTC");
    } finally {
      if (prevHv === undefined) delete process.env.HEALTHVAULT_DEFAULT_TIMEZONE;
      else process.env.HEALTHVAULT_DEFAULT_TIMEZONE = prevHv;
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });
});
