import { expect, test } from "bun:test";
import { createHealthParser, msOf, parseHealthXml } from "@/lib/xml";
import { fixtureXml } from "./helpers";

const rows = parseHealthXml(fixtureXml());

test("counts by kind", () => {
  expect(rows.records.length).toBe(10);
  expect(rows.workouts.length).toBe(1);
  expect(rows.summaries.length).toBe(1);
});

test("quantity record fields, including which device recorded it", () => {
  const steps = rows.records.filter((r) => r.typeIdentifier === "HKQuantityTypeIdentifierStepCount");
  expect(steps.length).toBe(5);
  expect(steps[0].unit).toBe("count");
  expect(steps[0].value).toBe(1000);
  expect(steps[0].day).toBe("2026-09-01");
  expect(new Set(steps.map((s) => s.sourceName))).toEqual(new Set(["Apple Watch", "Lipton's iPhone"]));
});

test("sleep maps to stage codes", () => {
  const sleep = rows.records.filter((r) => r.typeIdentifier === "HKCategoryTypeIdentifierSleepAnalysis");
  expect(sleep.map((s) => s.value).sort()).toEqual([4, 5]);
});

test("workout reads WorkoutStatistics children, not just attributes", () => {
  const w = rows.workouts[0];
  expect(w.durationSeconds).toBe(1920);       // duration="32" durationUnit="min"
  expect(w.totalDistance).toBeCloseTo(5.2, 5);
  expect(w.totalDistanceUnit).toBe("km");
  expect(w.totalEnergyBurned).toBeCloseTo(320.5, 5);
  expect(w.totalEnergyBurnedUnit).toBe("kcal");
  expect(w.avgHr).toBeCloseTo(148.5, 5);
  expect(w.minHr).toBe(96);
  expect(w.maxHr).toBe(181);
});

test("units are normalised on the way in", () => {
  const xml = `<HealthData locale="en_US">
    <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="1" durationUnit="hr"
              sourceName="Watch" startDate="2026-09-01 06:00:00 +0800" endDate="2026-09-01 07:00:00 +0800">
      <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceCycling" sum="10" unit="mi"/>
      <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="1000" unit="kJ"/>
    </Workout></HealthData>`;
  const w = parseHealthXml(xml).workouts[0];
  expect(w.durationSeconds).toBe(3600);
  expect(w.totalDistance).toBeCloseTo(16.09344, 4);   // 10 mi -> km
  expect(w.totalEnergyBurned).toBeCloseTo(239.0057, 3); // 1000 kJ -> kcal
});

test("old exports that still use Workout attributes keep working", () => {
  const xml = `<HealthData locale="en_US">
    <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="1800" durationUnit="sec"
             totalDistance="5.2" totalDistanceUnit="km" totalEnergyBurned="320" totalEnergyBurnedUnit="kcal"
             sourceName="Watch" startDate="2026-09-01 18:00:00 +0800" endDate="2026-09-01 18:30:00 +0800"/></HealthData>`;
  const w = parseHealthXml(xml).workouts[0];
  expect(w.durationSeconds).toBe(1800);
  expect(w.totalDistance).toBeCloseTo(5.2, 5);
  expect(w.totalEnergyBurned).toBeCloseTo(320, 5);
  expect(w.avgHr).toBeUndefined();
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

test("chunked feeding yields the same rows as a single write", () => {
  const xml = fixtureXml();
  const parser = createHealthParser();
  for (let i = 0; i < xml.length; i += 97) parser.write(xml.slice(i, i + 97));
  parser.end();
  const drained = parser.drain();
  expect(drained.records.length).toBe(10);
  expect(drained.workouts.length).toBe(1);
  expect(drained.summaries.length).toBe(1);
  expect(drained.records.map((r) => r.value)).toEqual(rows.records.map((r) => r.value));
  expect(parser.drain().records.length).toBe(0); // drain clears
});

test("a real export is huge: rows must drain incrementally, not accumulate", () => {
  const many = Array.from({ length: 2500 }, (_, i) =>
    `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-09-01 0${i % 10}:00:00 +0800" endDate="2026-09-01 0${i % 10}:05:00 +0800" value="${i}"/>`,
  ).join("");
  const parser = createHealthParser();
  parser.write(`<HealthData locale="en_US">${many}</HealthData>`);
  parser.end();
  expect(parser.pending()).toBe(2500);
});
