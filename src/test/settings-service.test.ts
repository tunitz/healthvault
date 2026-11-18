/**
 * Versioned settings persistence on a scratch DB: deterministic defaults, revision-checked writes,
 * strict validation of PUT input, tolerant reads of corrupt stored JSON, and reset.
 */
import { describe, expect, test } from "bun:test";
import { sqlite } from "@/db";
import {
  coerceStoredSettings,
  defaultSettings,
  getSettings,
  resetSettings,
  SettingsConflictError,
  updateSettings,
  validateSettingsInput,
  WIDGET_IDS,
} from "@/lib/services/settings";

describe("versioned app settings", () => {
  test("an empty store reads as defaults at revision 0 without writing", () => {
    expect(sqlite.prepare("SELECT count(*) AS n FROM app_settings").get()).toEqual({ n: 0 });
    const snapshot = getSettings();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.value).toEqual(defaultSettings());
    expect(Object.keys(snapshot.value.dashboard.widgets).sort()).toEqual([...WIDGET_IDS].sort());
  });

  test("mcp defaults keep local enabled and LAN disabled", () => {
    expect(defaultSettings().mcp).toEqual({ enabled: true, lanEnabled: false });
    expect(getSettings().value.mcp).toEqual({ enabled: true, lanEnabled: false });
  });

  test("appearance defaults include empty light and dark custom-colour variants", () => {
    expect(defaultSettings().appearance.customColors).toBeNull();
    expect(defaultSettings().appearance.customColorsDark).toBeNull();
  });

  test("old stored JSON without an mcp section gains the defaults", () => {
    const coerced = coerceStoredSettings({ version: 1, appearance: { mode: "dark" } });
    expect(coerced.mcp).toEqual({ enabled: true, lanEnabled: false });
    expect(coerced.appearance.mode).toBe("dark");
  });

  test("old stored JSON without a dark custom-colour variant gains the default", () => {
    const coerced = coerceStoredSettings({ version: 1, appearance: { mode: "dark", customColors: { accent: "#123456" } } });
    expect(coerced.appearance.customColors).toEqual({ accent: "#123456" });
    expect(coerced.appearance.customColorsDark).toBeNull();
  });

  test("a dark custom-colour variant validates strictly and round-trips", () => {
    expect(() => validateSettingsInput({ appearance: { customColorsDark: { accent: "red" } } })).toThrow();
    expect(() => validateSettingsInput({ appearance: { customColorsDark: [] } })).toThrow();
    const parsed = validateSettingsInput({ appearance: { customColorsDark: { background: "#101010", accent: "#60a5fa" } } });
    expect(parsed.appearance.customColorsDark).toEqual({ background: "#101010", accent: "#60a5fa" });
  });

  test("malformed dark colours in stored JSON drop to defaults without throwing", () => {
    const coerced = coerceStoredSettings({ version: 1, appearance: { customColorsDark: { accent: "red", background: "#101010" } } });
    expect(coerced.appearance.customColorsDark).toEqual({ background: "#101010" });
  });

  test("mcp booleans validate strictly and round-trip", () => {
    expect(() => validateSettingsInput({ mcp: { enabled: "yes" } })).toThrow();
    expect(() => validateSettingsInput({ mcp: { lanEnabled: 1 } })).toThrow();
    expect(() => validateSettingsInput({ mcp: "off" })).toThrow();
    const parsed = validateSettingsInput({ mcp: { enabled: false, lanEnabled: true } });
    expect(parsed.mcp).toEqual({ enabled: false, lanEnabled: true });
  });

  test("updates bump the revision and a stale revision is rejected", () => {
    const first = updateSettings(defaultSettings(), 0);
    expect(first.revision).toBe(1);
    const changed = defaultSettings();
    changed.appearance.mode = "dark";
    const second = updateSettings(changed, first.revision);
    expect(second.revision).toBe(2);
    expect(second.value.appearance.mode).toBe("dark");
    expect(() => updateSettings(defaultSettings(), 0)).toThrow(SettingsConflictError);
    expect(() => updateSettings(defaultSettings(), first.revision)).toThrow(SettingsConflictError);
    expect(getSettings().revision).toBe(2);
  });

  test("round-trips appearance, dashboard layout, named layouts and per-card preferences", () => {
    const next = defaultSettings();
    next.appearance.mode = "dark";
    next.appearance.chartPalette = "pastel";
    next.appearance.cornerStyle = "square";
    next.appearance.density = "compact";
    next.appearance.fontSize = 16;
    next.appearance.customColors = { accent: "#ff0000", background: "#101010" };
    next.appearance.customColorsDark = { accent: "#60a5fa", background: "#0f1626" };
    next.dashboard.widgets.nutrition.visible = false;
    next.dashboard.widgets.nutrition.display = "table";
    next.dashboard.widgets.nutrition.range = "7d";
    next.dashboard.widgets.sleep.display = "stages";
    next.dashboard.namedLayouts.focus = {
      name: "Focus",
      widgets: { ...defaultSettings().dashboard.widgets, nutrition: { ...defaultSettings().dashboard.widgets.nutrition, visible: false } },
    };
    next.dashboard.activeLayout = "focus";
    const saved = updateSettings(next, getSettings().revision);
    expect(saved.value).toEqual(next);
  });

  test("garbage input is rejected by the API validator", () => {
    const bad: unknown[] = [
      "garbage",
      null,
      42,
      [],
      { appearance: "dark" },
      { dashboard: [] },
      { appearance: { fontSize: 999 } },
      { appearance: { mode: "neon" } },
      { appearance: { customColors: { accent: "red" } } },
      { appearance: { customColorsDark: { foreground: "not-hex" } } },
      { dashboard: { widgets: { nutrition: { visible: "yes" } } } },
      { dashboard: { activeLayout: "missing" } },
    ];
    for (const input of bad) {
      expect(() => validateSettingsInput(input), JSON.stringify(input)).toThrow();
    }
  });

  test("an appearance PUT without a dark variant gains the default (client-side restore path)", () => {
    const parsed = validateSettingsInput({ version: 1, appearance: { mode: "dark", preset: "ocean" }, dashboard: {} });
    expect(parsed.appearance.mode).toBe("dark");
    expect(parsed.appearance.customColorsDark).toBeNull();
  });

  test("valid input ignores unknown keys rather than storing them", () => {
    const parsed = validateSettingsInput({
      appearance: { mode: "light", surprise: "nope" },
      unexpected: true,
    });
    expect(parsed.appearance.mode).toBe("light");
    expect(JSON.stringify(parsed)).not.toContain("surprise");
    expect(JSON.stringify(parsed)).not.toContain("unexpected");
  });

  test("corrupt stored JSON and malformed fields drop to defaults without throwing", () => {
    sqlite.prepare("UPDATE app_settings SET value = ? WHERE id = 1").run("{not valid json");
    const afterGarbage = getSettings();
    expect(afterGarbage.value.appearance.mode).toBe("system");
    expect(afterGarbage.revision).toBeGreaterThan(0);
    expect(coerceStoredSettings({ appearance: { mode: "neon", fontSize: 999 } }).appearance.mode).toBe("system");
    expect(coerceStoredSettings("garbage").appearance.mode).toBe("system");
  });

  test("reset restores defaults with the same concurrency guard", () => {
    const before = getSettings();
    const reset = resetSettings(before.revision);
    expect(reset.value).toEqual(defaultSettings());
    expect(reset.revision).toBe(before.revision + 1);
    expect(() => resetSettings(before.revision)).toThrow(SettingsConflictError);
  });
});
