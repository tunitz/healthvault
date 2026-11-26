/**
 * Migration 0005 and the profile extensions it enables (training goal, one-tap whey link).
 *
 * Runs against throwaway SQLite files under /tmp — never `data/health.db`. Covers a fresh
 * database, an additive upgrade of a pre-0005 (0004-shaped) database preserving existing rows,
 * goal parsing/validation/defaults, whey-link validation, and context exposure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-profile-goal-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

let sqlite: import("better-sqlite3").Database;
let profileService: typeof import("@/lib/services/profile");
let contextService: typeof import("@/lib/services/context");
let ValidationError: typeof import("@/lib/validate").ValidationError;

beforeAll(async () => {
  ({ sqlite } = await import("@/db"));
  profileService = await import("@/lib/services/profile");
  contextService = await import("@/lib/services/context");
  ({ ValidationError } = await import("@/lib/validate"));
});

afterAll(() => {
  // Do not close the shared `@/db` handle: `bun test` loads every test file into one runtime,
  // so a sibling suite holding the same module would be left with a closed connection.
  // Only remove our own scratch directory — the winning DATABASE_PATH may belong to a sibling.
  if (typeof sqlite?.name === "string" && sqlite.name.startsWith(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

function columns(table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

function tables(): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (row) => row.name,
  );
}

function indexes(table: string): string[] {
  return (
    sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'`)
      .all(table) as { name: string }[]
  ).map((row) => row.name);
}

function expectValidation(fn: () => unknown, status: number, pattern: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { status: number }).status).toBe(status);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected a ValidationError");
}

/** The committed migration folder pinned at 0004, for a legacy-shaped scratch database. */
function writeLegacyMigrations(directory: string): string {
  const folder = join(directory, "migrations-0004");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, 5);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    copyFileSync(join(process.cwd(), "drizzle", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

describe("migration 0005", () => {
  test("creates the new tables and profile columns on a fresh database", () => {
    expect(columns("profile")).toContain("goal_json");
    expect(columns("profile")).toContain("whey_link_json");
    expect(columns("planned_sessions")).toEqual([
      "id",
      "day",
      "kind",
      "intent",
      "title",
      "note",
      "target_json",
      "status",
      "workout_id",
      "block_start",
      "week_no",
      "created_at_ms",
      "updated_at_ms",
    ]);
    expect(columns("strength_sets")).toEqual([
      "id",
      "day",
      "exercise",
      "set_no",
      "reps",
      "load_kg",
      "note",
      "workout_id",
      "created_at_ms",
    ]);
    expect(indexes("planned_sessions")).toEqual(["idx_planned_sessions_day"]);
    expect(indexes("strength_sets").sort()).toEqual(["idx_strength_sets_day", "idx_strength_sets_exercise_day"]);
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("defaults planned status to 'planned' and set numbers to 1", () => {
    const now = Date.now();
    sqlite
      .prepare(
        "INSERT INTO planned_sessions (day, kind, title, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run("2026-11-16", "run", "Easy 30 min", now, now);
    sqlite
      .prepare("INSERT INTO strength_sets (day, exercise, created_at_ms) VALUES (?, ?, ?)")
      .run("2026-11-16", "Squat", now);
    const planned = sqlite
      .prepare("SELECT status, intent, workout_id FROM planned_sessions ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown>;
    expect(planned.status).toBe("planned");
    expect(planned.intent).toBeNull();
    expect(planned.workout_id).toBeNull();
    const set = sqlite
      .prepare("SELECT set_no, reps, load_kg FROM strength_sets ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown>;
    expect(set.set_no).toBe(1);
    expect(set.reps).toBeNull();
    expect(set.load_kg).toBeNull();
    // Cleanup keeps the legacy-upgrade assertions below on an empty table.
    sqlite.prepare("DELETE FROM planned_sessions").run();
    sqlite.prepare("DELETE FROM strength_sets").run();
  });

  test("upgrades a 0004 database additively, preserving existing profile and history", async () => {
    const directory = join(scratchDir, "legacy");
    mkdirSync(directory, { recursive: true });
    const databasePath = join(directory, "health.db");
    const raw = new Database(databasePath);
    try {
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
      const legacy = drizzle(raw);
      migrate(legacy, { migrationsFolder: writeLegacyMigrations(directory) });

      const now = Date.now();
      raw
        .prepare(
          `INSERT INTO profile (id, name, timezone, units, goals_note, created_at_ms, updated_at_ms)
           VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run("Legacy runner", "Asia/Manila", "metric", "sub-30 5K", now, now);
      raw
        .prepare(
          "INSERT INTO uploads (filename, bytes, status, records_inserted, records_duplicates, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("Legacy.zip", 42, "done", 0, 0, now);
      raw
        .prepare(
          `INSERT INTO foods (name, kcal_per_100g, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)`,
        )
        .run("Legacy whey", 380, now, now);
      const foodId = (raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      raw
        .prepare(
          `INSERT INTO food_log (day, meal, eaten_at_ms, food_id, name, grams, kcal, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("2026-11-08", "snack", now, foodId, "Legacy whey", 32.4, 123, now, now);
      expect(
        (raw.prepare("PRAGMA table_info(profile)").all() as { name: string }[]).map((c) => c.name),
      ).not.toContain("goal_json");

      migrate(legacy, { migrationsFolder: join(process.cwd(), "drizzle") });

      const profileRow = raw.prepare("SELECT * FROM profile WHERE id = 1").get() as Record<string, unknown>;
      expect(profileRow.name).toBe("Legacy runner");
      expect(profileRow.timezone).toBe("Asia/Manila");
      expect(profileRow.goals_note).toBe("sub-30 5K");
      expect(profileRow.goal_json).toBeNull();
      expect(profileRow.whey_link_json).toBeNull();
      expect(profileRow.updated_at_ms).toBe(now);

      const log = raw.prepare("SELECT name, grams, kcal FROM food_log").get() as Record<string, unknown>;
      expect(log.name).toBe("Legacy whey");
      expect(log.grams).toBe(32.4);
      expect(log.kcal).toBe(123);

      const tableNames = (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      ).map((row) => row.name);
      expect(tableNames).toContain("planned_sessions");
      expect(tableNames).toContain("strength_sets");
      expect((raw.prepare("SELECT COUNT(*) AS c FROM planned_sessions").get() as { c: number }).c).toBe(0);
      expect((raw.prepare("SELECT COUNT(*) AS c FROM strength_sets").get() as { c: number }).c).toBe(0);

      const journal = JSON.parse(
        readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      const applied = raw.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as {
        count: number;
      };
      expect(applied.count).toBe(journal.entries.length);
      expect(raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      raw.close();
    }
  });
});

describe("training goal", () => {
  test("defaults to sub-30:00 / 6.0 min/km and is not marked configured", () => {
    const profile = profileService.getProfile();
    expect(profile.goalJson).toBeNull();
    const goal = profileService.trainingGoal(profile);
    expect(goal).toEqual({
      type: "run5k",
      targetSeconds: 1800,
      targetPaceMinPerKm: 6,
      configured: false,
    });
  });

  test("stores the explicit target and derives pace from it", () => {
    const saved = profileService.updateProfile({ goal: { type: "run5k", targetSeconds: 1650 } });
    expect(JSON.parse(saved.goalJson!)).toEqual({ type: "run5k", targetSeconds: 1650 });
    const goal = profileService.trainingGoal(saved);
    expect(goal.targetSeconds).toBe(1650);
    expect(goal.targetPaceMinPerKm).toBe(5.5);
    expect(goal.configured).toBe(true);

    // An omitted targetSeconds falls back to the 30:00 default, not to zero.
    const partial = profileService.updateProfile({ goal: { type: "run5k" } });
    expect(profileService.trainingGoal(partial).targetSeconds).toBe(1800);
  });

  test("accepts seconds as a JSON string and rounds fractional seconds", () => {
    const stringy = profileService.updateProfile({ goalJson: '{"type":"run5k","targetSeconds":1740}' });
    expect(profileService.trainingGoal(stringy).targetSeconds).toBe(1740);
    const fractional = profileService.updateProfile({ goal: { targetSeconds: 1740.6 } });
    expect(profileService.trainingGoal(fractional).targetSeconds).toBe(1741);
  });

  test("rejects targets outside 20:00–59:59 and unknown goal types", () => {
    expectValidation(
      () => profileService.updateProfile({ goal: { targetSeconds: 1199 } }),
      400,
      /goal\.targetSeconds must be ≥ 1200/,
    );
    expectValidation(
      () => profileService.updateProfile({ goal: { targetSeconds: 3600 } }),
      400,
      /goal\.targetSeconds must be ≤ 3599/,
    );
    expectValidation(
      () => profileService.updateProfile({ goal: { type: "run10k", targetSeconds: 1800 } }),
      400,
      /goal\.type must be one of: run5k/,
    );
    expectValidation(() => profileService.updateProfile({ goal: "not json" }), 400, /goal must be an object or JSON string/);
    expectValidation(() => profileService.updateProfile({ goal: [1800] }), 400, /goal must be an object/);
    // Rejections never write a partial goal.
    expect(profileService.getProfile().goalJson).toBe(JSON.stringify({ type: "run5k", targetSeconds: 1741 }));
  });

  test("a cleared goal returns to the default; corrupt or out-of-range stored JSON is safe", () => {
    profileService.updateProfile({ goal: { targetSeconds: 1700 } });
    const cleared = profileService.updateProfile({ goal: null });
    expect(cleared.goalJson).toBeNull();
    expect(profileService.trainingGoal(cleared)).toMatchObject({ targetSeconds: 1800, configured: false });

    for (const stored of ['{"type":"run5k","targetSeconds":999}', '{"type":"run5k","targetSeconds":"fast"}', "{oops", '{"type":"run10k","targetSeconds":1800}']) {
      sqlite.prepare("UPDATE profile SET goal_json = ? WHERE id = 1").run(stored);
      const goal = profileService.trainingGoal(profileService.getProfile());
      expect(goal).toEqual({
        type: "run5k",
        targetSeconds: 1800,
        targetPaceMinPerKm: 6,
        configured: false,
      });
    }
    profileService.updateProfile({ goal: null });
  });
});

describe("one-tap whey link", () => {
  function addFood(name: string): number {
    const now = Date.now();
    sqlite
      .prepare("INSERT INTO foods (name, kcal_per_100g, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(name, 380, now, now);
    return (sqlite.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }

  function addSupplement(name: string): number {
    const now = Date.now();
    sqlite
      .prepare("INSERT INTO supplements (name, created_at_ms, updated_at_ms) VALUES (?, ?, ?)")
      .run(name, now, now);
    return (sqlite.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }

  test("defaults grams to one scoop (32.4 g) and meal to snack", () => {
    const foodId = addFood("Whey Protein, ACTIVE, Chocolate");
    const saved = profileService.updateProfile({ wheyLink: { foodId } });
    expect(JSON.parse(saved.wheyLinkJson!)).toEqual({
      foodId,
      supplementId: null,
      grams: 32.4,
      meal: "snack",
    });
    expect(profileService.parseWheyLink(saved)).toEqual({
      foodId,
      supplementId: null,
      grams: 32.4,
      meal: "snack",
    });
  });

  test("keeps an optional supplement and a chosen meal, and can be cleared", () => {
    const foodId = Number(
      (sqlite.prepare("SELECT id FROM foods WHERE name = ?").get("Whey Protein, ACTIVE, Chocolate") as { id: number }).id,
    );
    const supplementId = addSupplement("Whey (optional)");
    const saved = profileService.updateProfile({
      wheyLink: { foodId, supplementId, grams: 30, meal: "breakfast" },
    });
    expect(profileService.parseWheyLink(saved)).toEqual({
      foodId,
      supplementId,
      grams: 30,
      meal: "breakfast",
    });

    const cleared = profileService.updateProfile({ wheyLink: null });
    expect(cleared.wheyLinkJson).toBeNull();
    expect(profileService.parseWheyLink(cleared)).toBeNull();
  });

  test("rejects missing references and invalid amounts without writing", () => {
    const foodId = Number(
      (sqlite.prepare("SELECT id FROM foods WHERE name = ?").get("Whey Protein, ACTIVE, Chocolate") as { id: number }).id,
    );
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId: foodId + 9999 } }),
      404,
      /wheyLink\.foodId does not match a saved food/,
    );
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId, supplementId: 9999 } }),
      404,
      /wheyLink\.supplementId does not match a supplement/,
    );
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId, grams: 0 } }),
      400,
      /wheyLink\.grams must be ≥ 0.1/,
    );
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId, meal: "brunch" } }),
      400,
      /wheyLink\.meal must be one of: breakfast, lunch, dinner, snack/,
    );
    expectValidation(() => profileService.updateProfile({ wheyLink: {} }), 400, /wheyLink\.foodId is required/);
    expect(profileService.getProfile().wheyLinkJson).toBeNull();
  });

  test("unreadable stored JSON reads as unconfigured instead of throwing", () => {
    for (const stored of ["{oops", '{"foodId":0,"grams":32.4,"meal":"snack"}', '{"foodId":1,"grams":0}']) {
      sqlite.prepare("UPDATE profile SET whey_link_json = ? WHERE id = 1").run(stored);
      expect(profileService.parseWheyLink(profileService.getProfile())).toBeNull();
    }
    sqlite.prepare("UPDATE profile SET whey_link_json = NULL WHERE id = 1").run();
  });
});

describe("context exposure", () => {
  test("healthvaultContext carries the parsed goal and whey link", () => {
    const foodId = Number(
      (sqlite.prepare("SELECT id FROM foods WHERE name = ?").get("Whey Protein, ACTIVE, Chocolate") as { id: number }).id,
    );
    profileService.updateProfile({
      goal: { type: "run5k", targetSeconds: 1710 },
      wheyLink: { foodId, grams: 32.4, meal: "snack" },
    });

    const context = contextService.healthvaultContext();
    expect(context.profile.goal).toEqual({
      type: "run5k",
      targetSeconds: 1710,
      targetPaceMinPerKm: 5.7,
      configured: true,
    });
    expect(context.profile.wheyLink).toEqual({ foodId, supplementId: null, grams: 32.4, meal: "snack" });
    // The agent's profile_update path stores the same shape, so context and profile_get agree.
    expect(JSON.parse(context.profile.goalJson!)).toEqual({ type: "run5k", targetSeconds: 1710 });
  });

  test("an unconfigured profile still exposes the sub-30:00 default", () => {
    profileService.updateProfile({ goal: null, wheyLink: null });
    const context = contextService.healthvaultContext();
    expect(context.profile.goal.targetSeconds).toBe(1800);
    expect(context.profile.goal.targetPaceMinPerKm).toBe(6);
    expect(context.profile.goal.configured).toBe(false);
    expect(context.profile.wheyLink).toBeNull();
    expect(tables()).toContain("planned_sessions");
  });
});

describe("profile JSON input edge cases", () => {
  /** The whey food used by the link tests, created if the earlier suite has not run it yet. */
  function wheyFoodId(): number {
    const existing = sqlite
      .prepare("SELECT id FROM foods WHERE name = ?")
      .get("Whey Protein, ACTIVE, Chocolate") as { id: number } | undefined;
    if (existing) return existing.id;
    const now = Date.now();
    sqlite
      .prepare("INSERT INTO foods (name, kcal_per_100g, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run("Whey Protein, ACTIVE, Chocolate", 380, now, now);
    return (sqlite.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }

  test("blank goal fields fall back to 30:00 instead of storing zero", () => {
    for (const targetSeconds of ["", "   ", null]) {
      const saved = profileService.updateProfile({ goal: { type: "run5k", targetSeconds } });
      expect(JSON.parse(saved.goalJson!)).toEqual({ type: "run5k", targetSeconds: 1800 });
      expect(profileService.trainingGoal(saved)).toMatchObject({ targetSeconds: 1800, configured: true });
    }
    // The same blank arrives as JSON text from the agent surface.
    const asJson = profileService.updateProfile({ goalJson: '{"type":"run5k","targetSeconds":""}' });
    expect(JSON.parse(asJson.goalJson!)).toEqual({ type: "run5k", targetSeconds: 1800 });
  });

  test("explicit zero is rejected, never defaulted or stored", () => {
    profileService.updateProfile({ goal: { targetSeconds: 1725 } });
    expectValidation(
      () => profileService.updateProfile({ goal: { targetSeconds: 0 } }),
      400,
      /goal\.targetSeconds must be ≥ 1200/,
    );
    expectValidation(
      () => profileService.updateProfile({ goal: { targetSeconds: "0" } }),
      400,
      /goal\.targetSeconds must be ≥ 1200/,
    );
    expectValidation(
      () => profileService.updateProfile({ goal: { targetSeconds: false } }),
      400,
      /goal\.targetSeconds must be a number/,
    );
    // Nothing was written by the rejected attempts.
    expect(profileService.getProfile().goalJson).toBe(JSON.stringify({ type: "run5k", targetSeconds: 1725 }));
  });

  test("blank whey grams fall back to one scoop instead of storing null", () => {
    const foodId = wheyFoodId();
    for (const grams of ["", "   ", null]) {
      const saved = profileService.updateProfile({ wheyLink: { foodId, grams } });
      expect(JSON.parse(saved.wheyLinkJson!)).toEqual({ foodId, supplementId: null, grams: 32.4, meal: "snack" });
      expect(profileService.parseWheyLink(saved)).toEqual({ foodId, supplementId: null, grams: 32.4, meal: "snack" });
    }
    // A blank supplement id means "no supplement", not an invalid reference.
    const noSupplement = profileService.updateProfile({ wheyLink: { foodId, supplementId: "" } });
    expect(JSON.parse(noSupplement.wheyLinkJson!).supplementId).toBeNull();
  });

  test("explicit zero or a non-number whey grams is rejected", () => {
    const foodId = wheyFoodId();
    profileService.updateProfile({ wheyLink: { foodId, grams: 32.4 } });
    const before = profileService.getProfile().wheyLinkJson;
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId, grams: 0 } }),
      400,
      /wheyLink\.grams must be ≥ 0\.1/,
    );
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId, grams: "0" } }),
      400,
      /wheyLink\.grams must be ≥ 0\.1/,
    );
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId, grams: false } }),
      400,
      /wheyLink\.grams must be a number/,
    );
    expect(profileService.getProfile().wheyLinkJson).toBe(before);
  });

  test("a blank goal or whey string clears the stored value", () => {
    const foodId = wheyFoodId();
    profileService.updateProfile({ goal: { targetSeconds: 1710 }, wheyLink: { foodId } });
    expect(profileService.updateProfile({ goal: "" }).goalJson).toBeNull();
    expect(profileService.updateProfile({ goalJson: "   " }).goalJson).toBeNull();
    profileService.updateProfile({ wheyLink: { foodId } });
    expect(profileService.updateProfile({ wheyLink: "" }).wheyLinkJson).toBeNull();
    expect(profileService.updateProfile({ wheyLinkJson: "  " }).wheyLinkJson).toBeNull();
  });

  test("goal and goalJson must agree when both are sent", () => {
    const agreed = profileService.updateProfile({
      goal: { type: "run5k", targetSeconds: 1700 },
      goalJson: '{"type":"run5k","targetSeconds":1700}',
    });
    expect(agreed.goalJson).toBe(JSON.stringify({ type: "run5k", targetSeconds: 1700 }));

    expectValidation(
      () =>
        profileService.updateProfile({
          goal: { type: "run5k", targetSeconds: 1700 },
          goalJson: '{"type":"run5k","targetSeconds":1750}',
        }),
      400,
      /goal and goalJson disagree/,
    );
    // The conflict is rejected before any write.
    expect(profileService.getProfile().goalJson).toBe(JSON.stringify({ type: "run5k", targetSeconds: 1700 }));

    // Both spelling the same clear is not a conflict.
    expect(profileService.updateProfile({ goal: null, goalJson: null }).goalJson).toBeNull();
    expect(profileService.updateProfile({ goal: "", goalJson: "" }).goalJson).toBeNull();
  });

  test("wheyLink and wheyLinkJson must agree when both are sent", () => {
    const foodId = wheyFoodId();
    const agreed = profileService.updateProfile({
      wheyLink: { foodId, grams: 32.4 },
      wheyLinkJson: JSON.stringify({ foodId, supplementId: null, grams: 32.4, meal: "snack" }),
    });
    expect(profileService.parseWheyLink(agreed)).toEqual({
      foodId,
      supplementId: null,
      grams: 32.4,
      meal: "snack",
    });

    expectValidation(
      () =>
        profileService.updateProfile({
          wheyLink: { foodId, grams: 32.4 },
          wheyLinkJson: JSON.stringify({ foodId, grams: 40, meal: "snack" }),
        }),
      400,
      /wheyLink and wheyLinkJson disagree/,
    );
    expect(JSON.parse(profileService.getProfile().wheyLinkJson!).grams).toBe(32.4);

    // Matching clears are accepted; a mismatched clear still conflicts.
    expect(profileService.updateProfile({ wheyLink: null, wheyLinkJson: null }).wheyLinkJson).toBeNull();
    expectValidation(
      () => profileService.updateProfile({ wheyLink: { foodId }, wheyLinkJson: null }),
      400,
      /wheyLink and wheyLinkJson disagree/,
    );

    // An `undefined` alias is "not supplied" and must not clear the stored link.
    profileService.updateProfile({ wheyLink: { foodId, grams: 32.4 } });
    const untouched = profileService.updateProfile({ wheyLink: { foodId, grams: 32.4 }, wheyLinkJson: undefined });
    expect(profileService.parseWheyLink(untouched)?.grams).toBe(32.4);
  });

  test("corrupt stored JSON never resolves to a plausible value", () => {
    // `Number(null)` is 0 and `Number(true)` is 1, so these must not become a link or a goal.
    for (const stored of [
      '{"foodId":true,"grams":32.4,"meal":"snack"}',
      '{"foodId":null,"grams":32.4,"meal":"snack"}',
      '{"foodId":1,"grams":true}',
      '{"foodId":1,"grams":null}',
      "null",
      "[]",
    ]) {
      sqlite.prepare("UPDATE profile SET whey_link_json = ? WHERE id = 1").run(stored);
      expect(profileService.parseWheyLink(profileService.getProfile())).toBeNull();
    }
    sqlite.prepare("UPDATE profile SET whey_link_json = NULL WHERE id = 1").run();

    for (const stored of [
      '{"type":"run5k","targetSeconds":0}',
      '{"type":"run5k","targetSeconds":null}',
      '{"type":"run5k","targetSeconds":true}',
      "null",
    ]) {
      sqlite.prepare("UPDATE profile SET goal_json = ? WHERE id = 1").run(stored);
      expect(profileService.trainingGoal(profileService.getProfile())).toMatchObject({
        targetSeconds: 1800,
        configured: false,
      });
    }
    sqlite.prepare("UPDATE profile SET goal_json = NULL WHERE id = 1").run();
  });
});
