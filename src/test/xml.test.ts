import { expect, test } from "bun:test";
import { msOf, parseHealthXml } from "@/lib/xml";
import { fixtureXml } from "./helpers";

const rows = parseHealthXml(fixtureXml());

test("counts by kind", () => {
  expect(rows.records.length).toBe(9);
  expect(rows.workouts.length).toBe(1);
  expect(rows.summaries.length).toBe(1);
});

test("quantity record fields", () => {
  const step = rows.records.find((r) => r.typeIdentifier === "HKQuantityTypeIdentifierStepCount")!;
  expect(step.unit).toBe("count");
  expect(step.value).toBe(1234);
  expect(step.day).toBe("2026-09-01");
});

test("sleep maps to stage codes", () => {
  const sleep = rows.records.filter((r) => r.typeIdentifier === "HKCategoryTypeIdentifierSleepAnalysis");
  expect(sleep.map((s) => s.value).sort()).toEqual([4, 5, 6]);
});

test("workout metadata captured", () => {
  expect(JSON.parse(rows.workouts[0].metadataJson ?? "{}")).toEqual({ HKIndoorWorkout: "0" });
});

test("summary fields", () => {
  expect(rows.summaries[0].activeEnergyBurned).toBe(450.5);
  expect(rows.summaries[0].day).toBe("2026-09-01");
});

test("msOf parses Apple date format", () => {
  expect(Number.isNaN(msOf("2026-09-01 07:30:00 +0800"))).toBe(false);
});
