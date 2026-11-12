/**
 * The 16-week 5K training block and the planned-session lifecycle.
 *
 * `TRAINING_BLOCK` is the roadmap's block encoded once: three runs a week (Mon/Wed/Sat) plus
 * optional Tue/Fri strength. Planned rows are intent, never activity — they never enter workout
 * volume, pace or calorie totals. The imported `workouts` row stays the single source of what was
 * actually run; `workoutId` only links a completed planned session to it.
 */
import { desc, eq, isNotNull } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { plannedSessions, workouts } from "@/db/schema";
import { addDays, daysBetween, localDay, weekdayIndex } from "@/lib/day";
import { formatSeconds } from "@/lib/format";
import { getTimezone } from "@/lib/services/profile";
import { dayField, enumField, fail, idField } from "@/lib/validate";

/* ---------------------------------------------------------------------------------------------
 * Types and the block
 * ------------------------------------------------------------------------------------------- */

export const SESSION_KINDS = ["run", "strength", "rest", "test"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_INTENTS = ["easy", "quality", "long_easy", "test", "strength"] as const;
export type SessionIntent = (typeof SESSION_INTENTS)[number];

export const SESSION_STATUSES = ["planned", "done", "skipped"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionTarget = {
  structure: string;
  distanceKm?: number;
  paceMinPerKm?: number;
};

export type SessionTemplate = {
  weekday: number; // 0 = Sunday … 6 = Saturday, matching Date#getDay
  kind: SessionKind;
  intent: SessionIntent;
  title: string;
  note?: string;
  target?: SessionTarget;
};

export type BlockWeek = {
  weekNo: number;
  phase: string;
  sessions: SessionTemplate[];
};

const MON = 1;
const TUE = 2;
const WED = 3;
const FRI = 5;
const SAT = 6;

const STRIDES = "Optional: a few relaxed short strides when fresh.";

const EASY_30_40: SessionTarget = { structure: "30–40 min easy" };
const LONG_45_60: SessionTarget = { structure: "45–60 min easy" };
const LONG_CONVERSATIONAL: SessionTarget = { structure: "50–65 min conversational" };
const LONG_CONVERSATIONAL_LONG: SessionTarget = { structure: "50–70 min conversational" };
const QUALITY_6X2: SessionTarget = { structure: "6 × 2 min comfortably hard / 2 min easy" };

function easy(weekday: number, target: SessionTarget = EASY_30_40, note?: string): SessionTemplate {
  return { weekday, kind: "run", intent: "easy", title: "Easy run", ...(note ? { note } : {}), target };
}

function long(target: SessionTarget, title = "Long easy run"): SessionTemplate {
  return { weekday: SAT, kind: "run", intent: "long_easy", title, target };
}

function quality(title: string, target: SessionTarget): SessionTemplate {
  return { weekday: WED, kind: "run", intent: "quality", title, target };
}

function strength(weekday: number): SessionTemplate {
  return {
    weekday,
    kind: "strength",
    intent: "strength",
    title: "Strength",
    note: "Short strength session; optional and secondary to the runs.",
  };
}

/** One week always carries the optional Tue/Fri strength sessions; `startBlock` decides whether
 *  to materialise them, so the constant is the full roadmap block. */
function week(weekNo: number, phase: string, runs: SessionTemplate[]): BlockWeek {
  return { weekNo, phase, sessions: [...runs, strength(TUE), strength(FRI)] };
}

/** 4–5 × 600 m progressing to 3:36/600 m (6:00/km) with easy recovery. */
const SIX_HUNDRED_PROGRESSION: { reps: number; splitSeconds: number }[] = [
  { reps: 4, splitSeconds: 230 }, // 3:50 / 600 m
  { reps: 4, splitSeconds: 225 }, // 3:45 / 600 m
  { reps: 5, splitSeconds: 220 }, // 3:40 / 600 m
  { reps: 5, splitSeconds: 216 }, // 3:36 / 600 m = 6:00/km
];

function sixHundredWeek(weekNo: number, spec: { reps: number; splitSeconds: number }): BlockWeek {
  return week(weekNo, "5K pace", [
    easy(MON),
    quality(`Quality: ${spec.reps} × 600 m`, {
      structure: `${spec.reps} × 600 m at ${formatSeconds(spec.splitSeconds)} / 600 m with easy recovery`,
      paceMinPerKm: spec.splitSeconds / 0.6 / 60,
    }),
    long(LONG_CONVERSATIONAL),
  ]);
}

function oneKilometreWeek(weekNo: number): BlockWeek {
  return week(weekNo, "Sharpen", [
    easy(MON),
    quality("Quality: 3 × 1 km", {
      structure: "3 × 1 km at 6:00/km with easy recovery",
      paceMinPerKm: 6,
    }),
    long(LONG_CONVERSATIONAL_LONG, "Conversational long run"),
  ]);
}

/**
 * Weeks 1–4 base, 5–8 quality introduction, 9–12 5K pace, 13–16 sharpen and test.
 * Week 16 drops volume and ends with a `test` session instead of a long run.
 */
export const TRAINING_BLOCK: BlockWeek[] = [
  week(1, "Base", [easy(MON, EASY_30_40, STRIDES), easy(WED), long(LONG_45_60)]),
  week(2, "Base", [easy(MON, EASY_30_40, STRIDES), easy(WED), long(LONG_45_60)]),
  week(3, "Base", [easy(MON, EASY_30_40, STRIDES), easy(WED), long(LONG_45_60)]),
  week(4, "Base", [easy(MON, EASY_30_40, STRIDES), easy(WED), long(LONG_45_60)]),
  week(5, "Quality introduction", [easy(MON), quality("Quality: 6 × 2 min", QUALITY_6X2), long(LONG_45_60)]),
  week(6, "Quality introduction", [easy(MON), quality("Quality: 6 × 2 min", QUALITY_6X2), long(LONG_45_60)]),
  week(7, "Quality introduction", [easy(MON), quality("Quality: 6 × 2 min", QUALITY_6X2), long(LONG_45_60)]),
  week(8, "Quality introduction", [easy(MON), quality("Quality: 6 × 2 min", QUALITY_6X2), long(LONG_45_60)]),
  sixHundredWeek(9, SIX_HUNDRED_PROGRESSION[0]),
  sixHundredWeek(10, SIX_HUNDRED_PROGRESSION[1]),
  sixHundredWeek(11, SIX_HUNDRED_PROGRESSION[2]),
  sixHundredWeek(12, SIX_HUNDRED_PROGRESSION[3]),
  oneKilometreWeek(13),
  oneKilometreWeek(14),
  oneKilometreWeek(15),
  week(16, "Sharpen and test", [
    easy(MON, { structure: "20–25 min easy" }),
    easy(WED, { structure: "15–20 min easy" }),
    {
      weekday: SAT,
      kind: "test",
      intent: "test",
      title: "5K test",
      note: "Reduced volume; run the test only if recovery is good.",
      target: { structure: "5K time trial at 6:00/km", distanceKm: 5, paceMinPerKm: 6 },
    },
  ]),
];

export const BLOCK_WEEKS = TRAINING_BLOCK.length;

/* ---------------------------------------------------------------------------------------------
 * Reading the block
 * ------------------------------------------------------------------------------------------- */

export type PlannedSession = typeof plannedSessions.$inferSelect;

export type BlockWeekView = {
  weekNo: number;
  start: string;
  end: string;
  sessions: PlannedSession[];
  done: number;
  skipped: number;
  total: number;
};

export type BlockState = {
  blockStart: string;
  totalWeeks: number;
  /** 1-based week containing today, clamped to the block. */
  currentWeekNo: number;
  weekStart: string;
  weekEnd: string;
  today: string;
  thisWeek: PlannedSession[];
  weeks: BlockWeekView[];
  sessions: PlannedSession[];
  /** True once every session is done or skipped: a new block may then be started. */
  finished: boolean;
};

/** Parse a stored target without trusting its shape; null when absent or corrupt. */
export function sessionTarget(session: Pick<PlannedSession, "targetJson">): SessionTarget | null {
  if (!session.targetJson) return null;
  try {
    const parsed = JSON.parse(session.targetJson) as Partial<SessionTarget>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.structure !== "string") return null;
    return {
      structure: parsed.structure,
      ...(typeof parsed.distanceKm === "number" ? { distanceKm: parsed.distanceKm } : {}),
      ...(typeof parsed.paceMinPerKm === "number" ? { paceMinPerKm: parsed.paceMinPerKm } : {}),
    };
  } catch {
    return null;
  }
}

function sessionsOf(blockStart: string): PlannedSession[] {
  return db
    .select()
    .from(plannedSessions)
    .where(eq(plannedSessions.blockStart, blockStart))
    .orderBy(plannedSessions.day, plannedSessions.weekNo)
    .all();
}

/** The most recent block, finished or not; null when training has never been planned. */
export function currentBlock(): BlockState | null {
  const latest = db
    .select({ blockStart: plannedSessions.blockStart })
    .from(plannedSessions)
    .where(isNotNull(plannedSessions.blockStart))
    .orderBy(desc(plannedSessions.blockStart))
    .limit(1)
    .get();
  return latest?.blockStart ? blockState(latest.blockStart) : null;
}

/** Read one block by its first Monday. */
export function blockState(blockStart: string): BlockState | null {
  const sessions = sessionsOf(blockStart);
  if (sessions.length === 0) return null;

  const today = localDay(Date.now(), getTimezone());
  // Negative when the block starts in the future: clamp to week 1 rather than showing week 0.
  const weekNo = Math.min(
    BLOCK_WEEKS,
    Math.max(1, Math.floor(daysBetween(blockStart, today) / 7) + 1),
  );
  const weekStart = addDays(blockStart, (weekNo - 1) * 7);
  const weekEnd = addDays(weekStart, 6);

  const weeks: BlockWeekView[] = Array.from({ length: BLOCK_WEEKS }, (_, index) => {
    const start = addDays(blockStart, index * 7);
    const rows = sessions.filter((session) => session.weekNo === index + 1);
    return {
      weekNo: index + 1,
      start,
      end: addDays(start, 6),
      sessions: rows,
      done: rows.filter((session) => session.status === "done").length,
      skipped: rows.filter((session) => session.status === "skipped").length,
      total: rows.length,
    };
  });

  return {
    blockStart,
    totalWeeks: BLOCK_WEEKS,
    currentWeekNo: weekNo,
    weekStart,
    weekEnd,
    today,
    thisWeek: sessions.filter((session) => session.weekNo === weekNo),
    weeks,
    sessions,
    finished: sessions.every((session) => session.status !== "planned"),
  };
}

/** Monday strictly after `today`, so the start form never offers a day already underway. */
export function nextMonday(today: string): string {
  const offset = (1 - weekdayIndex(today) + 7) % 7 || 7;
  return addDays(today, offset);
}

/* ---------------------------------------------------------------------------------------------
 * Starting and updating
 * ------------------------------------------------------------------------------------------- */

export type StartBlockOptions = { includeStrength?: boolean };

export type StartBlockResult = {
  blockStart: string;
  weeks: number;
  sessions: number;
};

/**
 * Generate all 16 weeks of `planned_sessions`.
 *
 * Refuses while an earlier generated block still has a `planned` session, so a second block can
 * never interleave with the first. A finished block (everything done or skipped) does not block.
 */
export function startBlock(startDate: unknown, options: StartBlockOptions = {}): StartBlockResult {
  const start = dayField(startDate, "startDate");
  if (weekdayIndex(start) !== 1) fail("Start date must be a Monday", 400);

  const existing = db
    .select({ blockStart: plannedSessions.blockStart, status: plannedSessions.status })
    .from(plannedSessions)
    .where(isNotNull(plannedSessions.blockStart))
    .all();

  const unfinished = existing.find((row) => row.status === "planned");
  if (unfinished?.blockStart) {
    fail(
      `A training block starting ${unfinished.blockStart} is still in progress; finish or skip its remaining sessions first`,
      409,
    );
  }
  if (existing.some((row) => row.blockStart === start)) {
    fail(`A training block already starts on ${start}`, 409);
  }

  const includeStrength = options.includeStrength === true;
  const now = Date.now();
  const rows: (typeof plannedSessions.$inferInsert)[] = [];

  for (const blockWeek of TRAINING_BLOCK) {
    for (const session of blockWeek.sessions) {
      if (session.kind === "strength" && !includeStrength) continue;
      rows.push({
        day: addDays(start, (blockWeek.weekNo - 1) * 7 + (session.weekday - 1)),
        kind: session.kind,
        intent: session.intent,
        title: session.title,
        note: session.note ?? null,
        targetJson: session.target ? JSON.stringify(session.target) : null,
        status: "planned",
        blockStart: start,
        weekNo: blockWeek.weekNo,
        createdAtMs: now,
        updatedAtMs: now,
      });
    }
  }

  if (rows.length === 0) fail("Training block generated no sessions", 500);

  sqlite.transaction(() => {
    db.insert(plannedSessions).values(rows).run();
  })();

  return { blockStart: start, weeks: BLOCK_WEEKS, sessions: rows.length };
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/**
 * Move one session between planned/done/skipped.
 *
 * A workout link is only meaningful for a completed session and must be an imported workout on
 * the session's own day. Undo and skip clear the link, because the link described an effort that
 * is no longer being claimed as the session's completion.
 */
export function setSessionStatus(
  id: unknown,
  status: unknown,
  workoutId?: unknown,
): PlannedSession {
  const sessionId = idField(id, "id");
  const next = enumField(status, "status", SESSION_STATUSES) ?? fail("status is required");

  const existing = db
    .select()
    .from(plannedSessions)
    .where(eq(plannedSessions.id, sessionId))
    .get();
  if (!existing) fail("Planned session not found", 404);

  let link: number | null = null;
  if (hasValue(workoutId)) {
    if (next !== "done") fail("A workout can only be linked to a completed session", 400);
    const linkedId = idField(workoutId, "workoutId");
    const workout = db
      .select({ id: workouts.id, day: workouts.day })
      .from(workouts)
      .where(eq(workouts.id, linkedId))
      .get();
    if (!workout) fail("workoutId does not match an imported workout", 404);
    if (workout.day !== existing.day) fail("Linked workout must be on the session's day", 400);
    link = linkedId;
  }

  const updated = db
    .update(plannedSessions)
    .set({
      status: next,
      workoutId: next === "done" ? link : null,
      updatedAtMs: Date.now(),
    })
    .where(eq(plannedSessions.id, sessionId))
    .returning()
    .get();

  if (!updated) fail("Planned session not found", 404);
  return updated;
}
