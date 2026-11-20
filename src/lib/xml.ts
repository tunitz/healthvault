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
  avgHr?: number; minHr?: number; maxHr?: number;
  sourceName?: string; metadataJson?: string;
};
export type SummaryRow = {
  dateComponents: string; day: string;
  activeEnergyBurned?: number; activeEnergyBurnedGoal?: number;
  appleMoveMinutes?: number; appleMoveMinutesGoal?: number;
  appleExerciseTime?: number; appleExerciseTimeGoal?: number;
  appleStandHours?: number; appleStandHoursGoal?: number;
};
export type MeCharacteristics = {
  dateOfBirth?: string;
  biologicalSex?: string;
};

export type ParsedHealth = {
  records: HealthRecordRow[];
  workouts: WorkoutRow[];
  summaries: SummaryRow[];
  me: MeCharacteristics;
};

function digits2(s: string, i: number): number {
  const a = s.charCodeAt(i) - 48;
  const b = s.charCodeAt(i + 1) - 48;
  return a >= 0 && a <= 9 && b >= 0 && b <= 9 ? a * 10 + b : -1;
}

/** "2026-09-01 07:30:00 +0800" -> epoch ms. Fast-path fixed-offset parser avoids regex & Date string allocation across 2M+ timestamps. */
export function msOf(s: string): number {
  if (!s) return 0;
  // Standard Apple Health format: "YYYY-MM-DD HH:MM:SS +HHMM" (length 25) or "YYYY-MM-DDTHH:MM:SS+HH:MM" (25)
  if (
    s.length >= 19 &&
    s.charCodeAt(4) === 45 &&
    s.charCodeAt(7) === 45 &&
    (s.charCodeAt(10) === 32 || s.charCodeAt(10) === 84) &&
    s.charCodeAt(13) === 58 &&
    s.charCodeAt(16) === 58
  ) {
    const y1 = digits2(s, 0);
    const y2 = digits2(s, 2);
    const mo = digits2(s, 5);
    const d = digits2(s, 8);
    const hh = digits2(s, 11);
    const mi = digits2(s, 14);
    const ss = digits2(s, 17);
    if (y1 >= 0 && y2 >= 0 && mo >= 1 && d >= 1 && hh >= 0 && mi >= 0 && ss >= 0) {
      const year = y1 * 100 + y2;
      if (s.length === 19) {
        return new Date(year, mo - 1, d, hh, mi, ss).getTime();
      }
      // Skip optional space before offset
      let offIdx = 19;
      if (s.charCodeAt(offIdx) === 32) offIdx += 1;
      const signCh = s.charCodeAt(offIdx);
      if (signCh === 90 && offIdx + 1 === s.length) {
        return Date.UTC(year, mo - 1, d, hh, mi, ss);
      }
      if (signCh === 43 || signCh === 45) {
        const oh = digits2(s, offIdx + 1);
        const colon = s.charCodeAt(offIdx + 3) === 58 ? 1 : 0;
        const om = digits2(s, offIdx + 3 + colon);
        if (oh >= 0 && om >= 0 && offIdx + 5 + colon === s.length) {
          const offsetMs = (oh * 60 + om) * 60_000 * (signCh === 43 ? 1 : -1);
          return Date.UTC(year, mo - 1, d, hh, mi, ss) - offsetMs;
        }
      }
    }
  }
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

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const dayOf = (iso: string) => iso.slice(0, 10);

// Apple exports whatever unit the recording device used; known distance units are normalised to km.
export function toKm(value: number, unit?: string): number | undefined {
  switch ((unit ?? "").trim().toLowerCase()) {
    case "km": return value;
    case "mi": return value * 1.609344;
    case "m": return value / 1000;
    case "yd": return value * 0.0009144;
    case "ft": return value * 0.0003048;
    default: return undefined;
  }
}
export function toKcal(value: number, unit?: string): number {
  const trimmed = (unit ?? "").trim();
  // Capital-C "Cal" (dietary/Apple Health Calories) is kilocalories (kcal), not small calories.
  if (trimmed === "Cal") return value;
  switch (trimmed.toLowerCase()) {
    case "kcal": return value;
    case "kj": return value * 0.2390057;
    case "cal": return value / 1000;
    default: return value;
  }
}
export function toSeconds(value: number, unit?: string): number {
  const u = (unit ?? "sec").toLowerCase();
  if (u.startsWith("min")) return value * 60;
  if (u.startsWith("h")) return value * 3600;
  return value;
}

type WorkoutStat = { sum?: string; average?: string; minimum?: string; maximum?: string; unit?: string };

/**
 * Incremental parser: feed it the export in arbitrary chunks (a real export is hundreds of
 * MB of XML, so the caller streams it) and drain rows out as they are produced.
 */
export function createHealthParser() {
  const rows: ParsedHealth = { records: [], workouts: [], summaries: [], me: {} };

  const p = sax.parser(true); // strict: real exports are well-formed XML
  let rec: sax.Tag | null = null;
  let inCorrelation = false;
  let workout: sax.Tag | null = null;
  let meta: Record<string, string> = {};
  let stats: Record<string, WorkoutStat> = {};

  p.onopentag = (t: sax.Tag) => {
    if (t.name === "Correlation") { inCorrelation = true; return; }
    if (t.name === "Me") {
      // <Me HKCharacteristicTypeIdentifierDateOfBirth="…" …/> — Apple's only source of
      // birth date and biological sex; ignoring it is why profile fields started empty.
      const a = t.attributes;
      const dob = String(a.HKCharacteristicTypeIdentifierDateOfBirth ?? "");
      const sex = String(a.HKCharacteristicTypeIdentifierBiologicalSex ?? "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) rows.me.dateOfBirth = dob;
      if (sex) rows.me.biologicalSex = sex.replace(/^HKBiologicalSex/, "").toLowerCase();
      return;
    }
    if (workout) {
      // distance / energy / heart rate for a workout live here, not on the <Workout> element
      if (t.name === "WorkoutStatistics") {
        const key = String(t.attributes.type ?? "");
        if (key) stats[key] = t.attributes as unknown as WorkoutStat;
      } else if (t.name === "MetadataEntry") {
        meta[String(t.attributes.key)] = String(t.attributes.value);
      }
      return;
    }
    if (inCorrelation) return; // inner Records are duplicated as top-level Records in the same file
    if (t.name === "Workout") { workout = t; meta = {}; stats = {}; return; }
    if (t.name === "ActivitySummary") {
      const a = t.attributes;
      const energyUnit = a.activeEnergyBurnedUnit as string | undefined;
      const energyRaw = num(a.activeEnergyBurned);
      const energyGoalRaw = num(a.activeEnergyBurnedGoal);
      rows.summaries.push({
        dateComponents: String(a.dateComponents ?? ""), day: dayOf(String(a.dateComponents ?? "")),
        activeEnergyBurned: energyRaw === undefined ? undefined : toKcal(energyRaw, energyUnit),
        activeEnergyBurnedGoal: energyGoalRaw === undefined ? undefined : toKcal(energyGoalRaw, energyUnit),
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
      const startDate = String(a.startDate ?? "");
      const endDate = String(a.endDate ?? "");

      const pick = (...needles: string[]): WorkoutStat | undefined => {
        for (const n of needles) if (stats[n]) return stats[n];
        return undefined;
      };
      const anyWith = (needle: string) =>
        Object.entries(stats).find(([k]) => k.toLowerCase().includes(needle))?.[1];

      // prefer the running/walking distance, then any distance the export recorded
      const distStat = pick("HKQuantityTypeIdentifierDistanceWalkingRunning") ?? anyWith("distance");
      const energyStat = pick("HKQuantityTypeIdentifierActiveEnergyBurned") ?? anyWith("energyburned");
      const hrStat = pick("HKQuantityTypeIdentifierHeartRate") ?? anyWith("heartrate");

      // attribute fallbacks cover exports from older iOS versions, where these were attributes
      const distRaw = num(distStat?.sum) ?? num(a.totalDistance as string | undefined);
      const distUnit = distStat?.unit ?? (a.totalDistanceUnit as string | undefined);
      const distanceKm = distRaw === undefined ? undefined : toKm(distRaw, distUnit);
      const hasUnsupportedDistanceUnit = distRaw !== undefined && distanceKm === undefined && !!distUnit?.trim();
      const totalDistance = distanceKm ?? (hasUnsupportedDistanceUnit ? distRaw : undefined);
      const totalDistanceUnit = distanceKm !== undefined || distRaw === undefined
        ? "km"
        : hasUnsupportedDistanceUnit
          ? distUnit
          : undefined;
      const energyRaw = num(energyStat?.sum) ?? num(a.totalEnergyBurned as string | undefined);
      const energyUnit = energyStat?.unit ?? (a.totalEnergyBurnedUnit as string | undefined);

      rows.workouts.push({
        workoutActivityType: String(a.workoutActivityType ?? "Unknown"),
        startDate, startMs: msOf(startDate), day: dayOf(startDate),
        endDate, endMs: msOf(endDate),
        // durationUnit is "min" in most real exports; storing it as seconds without converting
        // made every workout look 60x shorter than it was.
        durationSeconds: num(a.duration) === undefined ? undefined : toSeconds(num(a.duration)!, a.durationUnit as string | undefined),
        // Persist unsupported distances only with their original unit so the query layer keeps
        // them unknown. A numeric value without a unit cannot safely be interpreted as km.
        totalDistance,
        totalDistanceUnit,
        totalEnergyBurned: energyRaw === undefined ? undefined : toKcal(energyRaw, energyUnit),
        totalEnergyBurnedUnit: "kcal",
        avgHr: num(hrStat?.average),
        minHr: num(hrStat?.minimum),
        maxHr: num(hrStat?.maximum),
        sourceName: a.sourceName,
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
      rows.records.push({
        typeIdentifier: type, unit: String(a.unit ?? ""), value,
        startDate, startMs: msOf(startDate), day: dayOf(startDate),
        endDate, endMs: msOf(endDate), sourceName: String(a.sourceName ?? ""),
      });
      rec = null;
    }
  };

  return {
    write: (chunk: string) => { p.write(chunk); },
    end: () => { p.close(); },
    /** rows parsed so far */
    pending: () => rows.records.length + rows.workouts.length + rows.summaries.length,
    /** hand out the parsed rows and forget them (keeps memory bounded) */
    drain: (): ParsedHealth => ({
      records: rows.records.splice(0, rows.records.length),
      workouts: rows.workouts.splice(0, rows.workouts.length),
      summaries: rows.summaries.splice(0, rows.summaries.length),
      me: { ...rows.me },
    }),
    /** <Me> is one element near the top; it is kept for the whole parse. */
    characteristics: (): MeCharacteristics => ({ ...rows.me }),
  };
}

/** One-shot helper (tests, small documents). */
export function parseHealthXml(xml: string): ParsedHealth {
  const parser = createHealthParser();
  parser.write(xml);
  parser.end();
  return parser.drain();
}
