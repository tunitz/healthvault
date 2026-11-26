/**
 * Configurable dashboard registry, deterministic ordering, and the three dashboard correctness
 * fixes (supplement hint, empty-state trigger, last successful import).
 */
import { describe, expect, test } from "bun:test";
import {
  allowedDisplay,
  isWidgetId,
  orderedVisibleWidgets,
  RANGE_DAYS,
  SIZE_SPAN,
  WIDGET_IDS,
  WIDGET_REGISTRY,
} from "@/components/dashboard/registry";
import { defaultAppSettings, defaultWidgetPrefs } from "@/components/dashboard/defaults";
import {
  asleepHoursByNight,
  hasDashboardContent,
  lastSuccessfulUpload,
  remainingDueCount,
  supplementHint,
  type UploadAttempt,
} from "@/components/dashboard/data";

describe("widget registry", () => {
  test("all nine widgets have metadata and an allowed view list", () => {
    expect(WIDGET_IDS.length).toBe(9);
    expect(WIDGET_REGISTRY.length).toBe(9);
    for (const meta of WIDGET_REGISTRY) {
      expect(WIDGET_IDS).toContain(meta.id);
      expect(meta.displays).toContain("summary");
    }
    expect(isWidgetId("nutrition")).toBe(true);
    expect(isWidgetId("unknown")).toBe(false);
  });

  test("each widget only offers views meaningful for it", () => {
    expect(allowedDisplay("nutrition", "line" as never)).toBe("summary");
    expect(allowedDisplay("nutrition", "table")).toBe("table");
    expect(allowedDisplay("sleep", "stages")).toBe("stages");
    expect(allowedDisplay("supplements", "adherence")).toBe("adherence");
    expect(allowedDisplay("supplements", "line" as never)).toBe("summary");
  });

  test("defaults keep every widget visible, in registry order", () => {
    const widgets = defaultWidgetPrefs();
    expect(orderedVisibleWidgets(widgets).map(({ id }) => id)).toEqual([...WIDGET_IDS]);
    expect(Object.values(widgets).every((pref) => pref.visible && pref.range === "30d")).toBe(true);
    expect(new Set(Object.values(SIZE_SPAN)).size).toBe(3);
    expect(RANGE_DAYS["1y"]).toBe(365);
  });

  test("ordering is deterministic, with hidden widgets excluded and ties broken by id", () => {
    const widgets = defaultWidgetPrefs();
    widgets.activity.order = 1;
    widgets.nutrition.order = 2;
    widgets.sleep.visible = false;
    widgets.weight.order = 2;
    const result = orderedVisibleWidgets(widgets);
    expect(result[0].id).toBe("activity");
    expect(result.map(({ id }) => id)).not.toContain("sleep");
    expect(result.filter(({ pref }) => pref.order === 2).map(({ id }) => id)).toEqual(["nutrition", "weight"]);
  });

  test("default settings version and sections are stable", () => {
    const settings = defaultAppSettings();
    expect(settings.version).toBe(1);
    expect(settings.appearance.mode).toBe("system");
    expect(settings.dashboard.activeLayout).toBeNull();
  });
});

describe("correctness fix 1 — supplement hint", () => {
  const item = (logged: boolean, time: string | null = null) => ({ logged, schedule: { time } });

  test("all taken when everything logged", () => {
    expect(supplementHint({ taken: 2, total: 2, items: [item(true), item(true)] })).toBe("All taken");
  });

  test("a null next supplement with untaken items is NOT reported as all taken", () => {
    const checklist = { taken: 1, total: 2, items: [item(true), item(false, "20:00")] };
    expect(remainingDueCount(checklist.items)).toBe(1);
    expect(supplementHint(checklist, null)).toBe("1 remaining today");
  });

  test("an already-due item is named as next", () => {
    const checklist = { taken: 0, total: 2, items: [item(false, "08:00"), item(false)] };
    expect(supplementHint(checklist, "Vitamin D at 08:00")).toBe("Next: Vitamin D at 08:00");
  });

  test("no scheduled supplements", () => {
    expect(supplementHint({ taken: 0, total: 0, items: [] })).toBe("None scheduled");
  });
});

describe("correctness fix 2 — empty state", () => {
  const empty = {
    records: 0, nutritionEntries: 0, latestMeasurement: false,
    supplementLogs: 0, supplementsScheduled: 0, uploads: 0,
  };

  test("nothing at all shows onboarding", () => {
    expect(hasDashboardContent(empty)).toBe(false);
  });

  test("manual content is shown even with zero imported records", () => {
    expect(hasDashboardContent({ ...empty, nutritionEntries: 2 })).toBe(true);
    expect(hasDashboardContent({ ...empty, latestMeasurement: true })).toBe(true);
    expect(hasDashboardContent({ ...empty, supplementLogs: 1 })).toBe(true);
  });
});

describe("correctness fix 3 — last successful import", () => {
  const attempt = (status: string, id: number): UploadAttempt => ({
    status, filename: `export-${id}.zip`, finishedAtMs: id * 1000,
    inserted: id, createdAtMs: id * 1000,
  });

  test("a newer failure does not hide an earlier success", () => {
    const attempts = [attempt("failed", 3), attempt("done", 2), attempt("running", 4)];
    expect(lastSuccessfulUpload(attempts)?.filename).toBe("export-2.zip");
  });

  test("no completed import returns null", () => {
    expect(lastSuccessfulUpload([attempt("failed", 1), attempt("running", 2)])).toBeNull();
    expect(lastSuccessfulUpload([])).toBeNull();
  });
});

describe("sleep duration view", () => {
  test("only asleep stages enter the nightly total", () => {
    const result = asleepHoursByNight([
      { day: "2026-11-16", stage: 1, hours: 9 },
      { day: "2026-11-16", stage: 3, hours: 1 },
      { day: "2026-11-16", stage: 2, hours: 6 },
      { day: "2026-11-16", stage: 5, hours: 1.5 },
      { day: "2026-11-17", stage: 6, hours: 1.2 },
    ]);
    expect(result).toEqual([
      { day: "2026-11-16", value: 7.5 },
      { day: "2026-11-17", value: 1.2 },
    ]);
  });
});
