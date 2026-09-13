import sax from "sax";

export type HealthRecordRow = {
  typeIdentifier: string; unit: string; value: number;
  startDate: string; startMs: number; day: string;
  endDate: string; endMs: number; sourceName: string;
};
export type WorkoutRow = {
  workoutActivityType: string; startDate: string; startMs: number; day: string;
  endDate: string; endMs: number; durationSeconds?: number;
  totalDistance?: number; totalDistanceUnit?: string;
  totalEnergyBurned?: number; totalEnergyBurnedUnit?: string;
  sourceName?: string; metadataJson?: string;
};
export type SummaryRow = {
  dateComponents: string; day: string;
  activeEnergyBurned?: number; activeEnergyBurnedGoal?: number;
  appleMoveMinutes?: number; appleMoveMinutesGoal?: number;
  appleExerciseTime?: number; appleExerciseTimeGoal?: number;
  appleStandHours?: number; appleStandHoursGoal?: number;
};
export type ParsedHealth = { records: HealthRecordRow[]; workouts: WorkoutRow[]; summaries: SummaryRow[] };

/** "2026-09-01 07:30:00 +0800" -> epoch ms. Apple writes a space before the offset, which Date rejects verbatim. */
export function msOf(s: string): number {
  if (!s) return 0;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?$/);
  if (m) return new Date(`${m[1]}T${m[2]}${m[3] ? m[3] + ":" + m[4] : ""}`).getTime();
  return new Date(s).getTime();
}

const STAGE: Record<string, number> = {
  HKCategoryValueSleepAnalysisInBed: 1,
  HKCategoryValueSleepAnalysisAsleepUnspecified: 2,
  HKCategoryValueSleepAnalysisAsleep: 2,
  HKCategoryValueSleepAnalysisAwake: 3,
  HKCategoryValueSleepAnalysisAsleepCore: 4,
  HKCategoryValueSleepAnalysisAsleepDeep: 5,
  HKCategoryValueSleepAnalysisAsleepREM: 6,
};

const num = (v: string | undefined): number | undefined => (v === undefined || v === "" ? undefined : Number(v));
const dayOf = (iso: string) => iso.slice(0, 10);

export function parseHealthXml(xml: string): ParsedHealth {
  const records: HealthRecordRow[] = [];
  const workouts: WorkoutRow[] = [];
  const summaries: SummaryRow[] = [];

  const p = sax.parser(true); // strict: real exports are well-formed XML
  let rec: sax.Tag | null = null;
  let inCorrelation = false;
  let workout: sax.Tag | null = null;
  let meta: Record<string, string> = {};

  p.onopentag = (t: sax.Tag) => {
    if (t.name === "Correlation") { inCorrelation = true; return; }
    if (workout) {
      if (t.name === "MetadataEntry") meta[String(t.attributes.key)] = String(t.attributes.value);
      return;
    }
    if (inCorrelation) return; // inner Records are duplicated as top-level Records in the same file
    if (t.name === "Workout") { workout = t; meta = {}; return; }
    if (t.name === "ActivitySummary") {
      const a = t.attributes;
      summaries.push({
        dateComponents: String(a.dateComponents ?? ""), day: dayOf(String(a.dateComponents ?? "")),
        activeEnergyBurned: num(a.activeEnergyBurned), activeEnergyBurnedGoal: num(a.activeEnergyBurnedGoal),
        appleMoveMinutes: num(a.appleMoveMinutes), appleMoveMinutesGoal: num(a.appleMoveMinutesGoal),
        appleExerciseTime: num(a.appleExerciseTime), appleExerciseTimeGoal: num(a.appleExerciseTimeGoal),
        appleStandHours: num(a.appleStandHours), appleStandHoursGoal: num(a.appleStandHoursGoal),
      });
      return;
    }
    if (t.name === "Record") rec = t;
  };

  p.onclosetag = (name: string) => {
    if (name === "Correlation") { inCorrelation = false; return; }
    if (name === "Workout" && workout) {
      const a = workout.attributes;
      workouts.push({
        workoutActivityType: String(a.workoutActivityType ?? "Unknown"),
        startDate: String(a.startDate ?? ""), startMs: msOf(String(a.startDate ?? "")), day: dayOf(String(a.startDate ?? "")),
        endDate: String(a.endDate ?? ""), endMs: msOf(String(a.endDate ?? "")),
        durationSeconds: num(a.duration), totalDistance: num(a.totalDistance),
        totalDistanceUnit: a.totalDistanceUnit, totalEnergyBurned: num(a.totalEnergyBurned),
        totalEnergyBurnedUnit: a.totalEnergyBurnedUnit, sourceName: a.sourceName,
        metadataJson: Object.keys(meta).length ? JSON.stringify(meta) : undefined,
      });
      workout = null;
      return;
    }
    if (name === "Record" && rec) {
      const a = rec.attributes;
      const type = String(a.type ?? "");
      const rawValue = String(a.value ?? "");
      const value = type === "HKCategoryTypeIdentifierSleepAnalysis"
        ? (STAGE[rawValue] ?? 0)
        : type.startsWith("HKQuantity")
          ? (num(rawValue) ?? 0)
          : 1;
      const startDate = String(a.startDate ?? "");
      const endDate = String(a.endDate ?? startDate);
      records.push({
        typeIdentifier: type, unit: String(a.unit ?? ""), value,
        startDate, startMs: msOf(startDate), day: dayOf(startDate),
        endDate, endMs: msOf(endDate), sourceName: String(a.sourceName ?? ""),
      });
      rec = null;
    }
  };

  p.write(xml).close();
  return { records, workouts, summaries };
}
