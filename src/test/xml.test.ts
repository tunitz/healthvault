import { expect, test } from "bun:test";
import { createHealthParser, msOf, parseHealthXml } from "@/lib/xml";
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

test("chunked feeding yields the same rows as a single write", () => {
  const xml = fixtureXml();
  const parser = createHealthParser();
  for (let i = 0; i < xml.length; i += 97) parser.write(xml.slice(i, i + 97));
  parser.end();
  const drained = parser.drain();
  expect(drained.records.length).toBe(9);
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
