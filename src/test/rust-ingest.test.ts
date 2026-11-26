import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import Database from "better-sqlite3";
import { createHealthParser, parseHealthXml } from "@/lib/xml";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-rust-ingest-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

let runIngest: typeof import("@/lib/ingest").runIngest;
let sqlite: import("better-sqlite3").Database;

function buildSampleExportZip(): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Me HKCharacteristicTypeIdentifierDateOfBirth="1994-06-15" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexFemale"/>
  <Record type="HKQuantityTypeIdentifierHeight" unit="cm" value="168" startDate="2026-09-19 06:00:00 +0800" endDate="2026-09-19 06:00:00 +0800" sourceName="Health"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="72.5" startDate="2026-09-19 06:05:00 +0800" endDate="2026-09-19 06:05:00 +0800" sourceName="Apple &amp; Watch">
    <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="1"/>
  </Record>
  <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="not-a-number" startDate="2026-09-19 07:00:00 +0800" endDate="2026-09-19 07:00:00 +0800" sourceName="Scale"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" unit="" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-09-19 23:00:00 +0800" endDate="2026-09-20 00:30:00 +0800" sourceName="Watch"/>
  <Correlation type="HKCorrelationTypeIdentifierBloodPressure" startDate="2026-09-19 07:00:00 +0800" endDate="2026-09-19 07:00:00 +0800">
    <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" unit="mmHg" value="118" startDate="2026-09-19 07:00:00 +0800" endDate="2026-09-19 07:00:00 +0800" sourceName="Cuff"/>
  </Correlation>
  <ActivitySummary dateComponents="2026-09-19" activeEnergyBurned="1000" activeEnergyBurnedGoal="2000" activeEnergyBurnedUnit="kJ" appleMoveMinutes="30" appleExerciseTime="45" appleStandHours="11"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="15" durationUnit="min" sourceName="Watch" startDate="2026-09-19 17:00:00 +0800" endDate="2026-09-19 17:15:00 +0800">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <MetadataEntry key="HKTimeZone" value="Asia/Shanghai"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="1.2" unit="mi"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="210" unit="Cal"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="152" minimum="120" maximum="174" unit="count/min"/>
  </Workout>
</HealthData>`;

  const pts = Array.from({ length: 12 }, (_, i) => {
    const lat = (37.77 + i * 0.001).toFixed(6);
    const ele = (10 + i * 3).toFixed(1);
    const sec = i * 30;
    const min = String(Math.floor(sec / 60)).padStart(2, "0");
    const rem = String(sec % 60).padStart(2, "0");
    return `<trkpt lon="-122.420000" lat="${lat}"><ele>${ele}</ele><time>2026-09-19T09:${min}:${rem}Z</time></trkpt>`;
  }).join("\n");
  const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;

  const ecgSamples = Array.from({ length: 512 * 5 }, (_, i) => (i % 512 === 256 ? "600.0" : "0.0"));
  const ecg = [
    "Name,Test User",
    "Recorded Date,2026-09-19 09:00:00 +0000",
    "Classification,Sinus Rhythm",
    "Symptoms,",
    'Device,"Watch6,1"',
    "Sample Rate,512 hertz",
    "Unit,µV",
    "",
    ...ecgSamples,
  ].join("\n");

  return zipSync({
    "apple_health_export/export.xml": strToU8(xml),
    "apple_health_export/workout-routes/route_2026-09-19_5.00pm.gpx": strToU8(gpx),
    "apple_health_export/electrocardiograms/ecg_2026-09-19.csv": strToU8(ecg),
  });
}

beforeAll(async () => {
  ({ runIngest } = await import("@/lib/ingest"));
  ({ sqlite } = await import("@/db"));
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("Rust ingest hot loop and XML parser parity", () => {
  test("parseHealthXml in Rust matches streaming JS parser identically", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><HealthData>
      <Me HKCharacteristicTypeIdentifierDateOfBirth="1994-06-15" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
      <Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="250" startDate="2026-09-01 07:30:00 +0800" endDate="2026-09-01 07:35:00 +0800" sourceName="Watch &amp; Phone"/>
      <ActivitySummary dateComponents="2026-09-01" activeEnergyBurned="450" activeEnergyBurnedUnit="Cal"/>
    </HealthData>`;
    const rustParsed = parseHealthXml(xml);
    const jsParser = createHealthParser();
    jsParser.write(xml);
    jsParser.end();
    const jsParsed = jsParser.drain();
    expect(rustParsed).toEqual(jsParsed);
  });

  test("Rust runIngest ingests records, workouts, summaries, GPX routes, ECGs, and prefills profile idempotently", async () => {
    const prevMode = process.env.RUST_ANYTHING_MODE;
    process.env.RUST_ANYTHING_MODE = "new";
    try {
      const zip = buildSampleExportZip();
      const first = await runIngest(zip, "sample.zip", zip.length);
      expect(first.inserted).toBe(6); // 4 records + 1 workout + 1 summary
      expect(first.duplicates).toBe(0);
      expect(first.routesInserted).toBe(1);
      expect(first.ecgsInserted).toBe(1);

      const route = sqlite.prepare("SELECT workout_id, point_count, filename FROM workout_routes").get() as {
        workout_id: number | null;
        point_count: number;
        filename: string;
      };
      expect(route.workout_id).not.toBeNull();
      expect(route.point_count).toBe(12);
      expect(route.filename).toBe("route_2026-09-19_5.00pm.gpx");

      const ecg = sqlite.prepare("SELECT classification, avg_hr, device, sample_count FROM ecg_recordings").get() as {
        classification: string;
        avg_hr: number;
        device: string;
        sample_count: number;
      };
      expect(ecg).toEqual({
        classification: "Sinus Rhythm",
        avg_hr: 60,
        device: "Watch6,1",
        sample_count: 2560,
      });

      const prof = sqlite.prepare("SELECT birth_date, sex, height_cm FROM profile WHERE id = 1").get() as {
        birth_date: string;
        sex: string;
        height_cm: number;
      };
      expect(prof).toEqual({ birth_date: "1994-06-15", sex: "female", height_cm: 168 });

      // Re-import must be 100% idempotent
      const second = await runIngest(zip, "sample.zip", zip.length);
      expect(second.inserted).toBe(0);
      expect(second.duplicates).toBe(6);
      expect(second.routesInserted).toBe(0);
      expect(second.ecgsInserted).toBe(0);
    } finally {
      if (prevMode === undefined) delete process.env.RUST_ANYTHING_MODE;
      else process.env.RUST_ANYTHING_MODE = prevMode;
    }
  });

  test("Rust and JS fallback paths produce identical database rows", async () => {
    const zip = buildSampleExportZip();
    const prevMode = process.env.RUST_ANYTHING_MODE;

    const snapshot = () => {
      const tables = [
        "SELECT type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name FROM records ORDER BY type_identifier, start_date",
        "SELECT workout_activity_type, start_date, start_ms, day, end_date, end_ms, duration_seconds, total_distance, total_distance_unit, total_energy_burned, total_energy_burned_unit, avg_hr, min_hr, max_hr, source_name, metadata_json FROM workouts ORDER BY start_date",
        "SELECT date_components, day, active_energy_burned, active_energy_burned_goal, apple_move_minutes, apple_exercise_time, apple_stand_hours FROM activity_summaries ORDER BY date_components",
        "SELECT filename, day, start_ms, end_ms, point_count, distance_km, elevation_gain_m, elevation_loss_m, polyline_json, splits_json FROM workout_routes ORDER BY filename",
        "SELECT filename, recorded_at, recorded_at_ms, day, classification, avg_hr, sampling_hz, unit, sample_count, samples_json, symptoms, device FROM ecg_recordings ORDER BY filename",
      ];
      return tables.map((sql) => sqlite.prepare(sql).all());
    };

    const clearTables = () => {
      sqlite.exec("DELETE FROM workout_routes; DELETE FROM ecg_recordings; DELETE FROM records; DELETE FROM workouts; DELETE FROM activity_summaries;");
    };

    try {
      clearTables();
      process.env.RUST_ANYTHING_MODE = "new";
      await runIngest(zip, "parity-rust.zip", zip.length);
      const rustRows = snapshot();

      clearTables();
      process.env.RUST_ANYTHING_MODE = "old";
      await runIngest(zip, "parity-js.zip", zip.length);
      const jsRows = snapshot();

      expect(rustRows).toEqual(jsRows);
    } finally {
      if (prevMode === undefined) delete process.env.RUST_ANYTHING_MODE;
      else process.env.RUST_ANYTHING_MODE = prevMode;
    }
  });

  test("Rust ingest rejects missing export.xml and marks upload failed", async () => {
    const prevMode = process.env.RUST_ANYTHING_MODE;
    process.env.RUST_ANYTHING_MODE = "new";
    try {
      const badZip = zipSync({ "readme.txt": strToU8("no xml here") });
      await expect(runIngest(badZip, "missing-xml.zip", badZip.length)).rejects.toThrow(/export\.xml not found in zip/);
      const dbRead = new Database(process.env.DATABASE_PATH!, { readonly: true });
      const latest = dbRead.prepare("SELECT status, message FROM uploads ORDER BY id DESC LIMIT 1").get() as {
        status: string;
        message: string;
      };
      dbRead.close();
      expect(latest.status).toBe("failed");
      expect(latest.message).toContain("export.xml not found in zip");
    } finally {
      if (prevMode === undefined) delete process.env.RUST_ANYTHING_MODE;
      else process.env.RUST_ANYTHING_MODE = prevMode;
    }
  });
});
