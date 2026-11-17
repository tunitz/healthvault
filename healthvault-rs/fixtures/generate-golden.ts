/**
 * Generate anonymized fixtures + golden outputs from the CURRENT TypeScript implementation.
 * Run from the repository root with:  bun healthvault-rs/fixtures/generate-golden.ts
 *
 * This script imports only dependency-free/pure modules (src/lib/day.ts and src/lib/xml.ts).
 * It never opens the database and never reads ./data/. All source records below are synthetic.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { localDayStartMs, localDayEndMs, addDays, weekStart, weekdayIndex } from "../../src/lib/day";
import { parseHealthXml, toKm, toKcal, toSeconds, msOf } from "../../src/lib/xml";

const OUT = new URL(".", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1990-05-04" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-11-17 08:00:00 +0800" endDate="2026-11-17 08:05:00 +0800" value="1200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-11-17 09:00:00 +0800" endDate="2026-11-17 09:05:00 +0800" value="800"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-11-17 08:00:00 +0800" endDate="2026-11-17 08:05:00 +0800" value="2500"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" unit="count" startDate="2026-11-18 01:00:00 +0800" endDate="2026-11-18 02:00:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Correlation>
   <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-11-17 10:00:00 +0800" endDate="2026-11-17 10:05:00 +0800" value="99999"/>
 </Correlation>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="40" durationUnit="min" sourceName="Watch" startDate="2026-11-17 06:00:00 +0800" endDate="2026-11-17 06:40:00 +0800">
   <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>
   <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="420" unit="kcal"/>
   <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="152" minimum="121" maximum="178" unit="count/min"/>
   <MetadataEntry key="weather" value="Clear"/>
 </Workout>
 <ActivitySummary dateComponents="2026-11-17" activeEnergyBurned="500" appleStandHours="12"/>
</HealthData>`;

const parsed = parseHealthXml(xml);
const zone = "Asia/Manila";
const days = ["2026-03-08", "2026-11-01", "2026-11-17", "2026-11-18"];

const golden = {
  generatedBy: "healthvault-rs/fixtures/generate-golden.ts from the current TypeScript source",
  synthetic: true,
  day: Object.fromEntries(days.map((day) => [day, {
    startMs: localDayStartMs(day, zone),
    endMs: localDayEndMs(day, zone),
    weekdayIndex: weekdayIndex(day),
    weekStart: weekStart(day),
    nextDay: addDays(day, 1),
  }])),
  normalization: {
    kmFromMiles: toKm(1, "mi"),
    kmFromMeters: toKm(1000, "m"),
    kcalFromKj: toKcal(100, "kj"),
    secondsFromMin: toSeconds(40, "min"),
    appleTimestampMs: msOf("2026-09-01 07:30:00 +0800"),
  },
  parsed: {
    records: parsed.records,
    workouts: parsed.workouts,
    summaries: parsed.summaries,
    me: parsed.me,
  },
};

writeFileSync(new URL("apple-health-fixture.xml", import.meta.url), xml, "utf8");
writeFileSync(new URL("golden.json", import.meta.url), JSON.stringify(golden, null, 2) + "\n", "utf8");
console.log(`wrote fixtures to ${OUT}`);
