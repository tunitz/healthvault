import { sqlite } from "@/db";
import { fail, ValidationError } from "@/lib/validate";

/* ---------------------------------------------------------------------------------------------
 * AppSettings — one validated, versioned object persisted as JSON in the app_settings singleton.
 * Preferences only: no credentials, tokens, health data or secrets ever live in this table.
 * ------------------------------------------------------------------------------------------- */

export const THEME_MODES = ["system", "light", "dark"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export const CORNER_STYLES = ["rounded", "soft", "square"] as const;
export const CHART_PALETTES = ["default", "vibrant", "pastel", "monochrome"] as const;
export const WIDGET_IDS = [
  "nutrition",
  "activity",
  "supplements",
  "measurements",
  "sleep",
  "weight",
  "workouts",
  "training",
  "imports",
] as const;
export const WIDGET_SIZES = ["small", "medium", "large"] as const;
export const WIDGET_RANGES = ["7d", "30d", "90d", "1y"] as const;
export const WIDGET_DISPLAYS = [
  "summary",
  "table",
  "line",
  "area",
  "bars",
  "checklist",
  "adherence",
  "stages",
  "duration",
] as const;

export type ThemeMode = (typeof THEME_MODES)[number];
export type Density = (typeof DENSITIES)[number];
export type CornerStyle = (typeof CORNER_STYLES)[number];
export type ChartPalette = (typeof CHART_PALETTES)[number];
export type WidgetSize = (typeof WIDGET_SIZES)[number];
export type WidgetRange = (typeof WIDGET_RANGES)[number];
export type WidgetDisplay = (typeof WIDGET_DISPLAYS)[number];

export type CustomColors = {
  accent?: string;
  background?: string;
  foreground?: string;
  muted?: string;
  border?: string;
};

export type WidgetPreference = {
  visible: boolean;
  order: number;
  size: WidgetSize;
  range: WidgetRange;
  display: WidgetDisplay;
};

export type NamedLayout = { name: string; widgets: Record<string, WidgetPreference> };

export type AppearanceSettings = {
  mode: ThemeMode;
  preset: string;
  /** Explicit overrides for the light variant; merged over the preset's light colours. */
  customColors: CustomColors | null;
  /**
   * Explicit overrides for the dark variant; merged over the preset's dark colours. Optional at
   * the type level so older client-side draft helpers still compile — every persisted/coerced
   * value gains it via `defaultSettings`, exactly like `mcp` below.
   */
  customColorsDark?: CustomColors | null;
  density: Density;
  fontSize: number;
  cornerStyle: CornerStyle;
  chartPalette: ChartPalette;
};

export type DashboardSettings = {
  widgets: Record<string, WidgetPreference>;
  namedLayouts: Record<string, NamedLayout>;
  activeLayout: string | null;
};

/**
 * Machine-access preferences. `enabled` is true by default so the existing local agent/stdio
 * connector keeps working after an upgrade; `lanEnabled` is false so machine access is local-only
 * until the user explicitly opts in. These are preferences only — no token or secret is stored.
 */
export type McpSettings = {
  enabled: boolean;
  lanEnabled: boolean;
};

/** Optional at the type level so older client-side draft helpers that construct a partial
 * AppSettings still compile; every persisted/coerced value gains it via `defaultSettings`. */
export const DEFAULT_MCP_SETTINGS: McpSettings = { enabled: true, lanEnabled: false };

export type AppSettings = {
  version: 1;
  appearance: AppearanceSettings;
  dashboard: DashboardSettings;
  mcp?: McpSettings;
};

/** The shape returned by the API alongside the value, for optimistic concurrency. */
export type SettingsSnapshot = Readonly<{
  value: AppSettings;
  revision: number;
  updatedAtMs: number;
}>;

/** A stale write from another device. The API maps this to HTTP 409. */
export class SettingsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsConflictError";
  }
}

/* --------------------------------- defaults -------------------------------------------------- */

const DEFAULT_WIDGET_RANGE: WidgetRange = "30d";
const DEFAULT_WIDGET_SIZE: WidgetSize = "medium";

function defaultWidget(order: number): WidgetPreference {
  return { visible: true, order, size: DEFAULT_WIDGET_SIZE, range: DEFAULT_WIDGET_RANGE, display: "summary" };
}

/** The canonical defaults: every widget visible, in registry order, summary view, 30 days. */
export function defaultSettings(): AppSettings {
  const widgets: Record<string, WidgetPreference> = {};
  WIDGET_IDS.forEach((id, index) => {
    widgets[id] = defaultWidget(index + 1);
  });
  return {
    version: 1,
    appearance: {
      mode: "system",
      preset: "default",
      customColors: null,
      customColorsDark: null,
      density: "comfortable",
      fontSize: 14,
      cornerStyle: "rounded",
      chartPalette: "default",
    },
    dashboard: { widgets, namedLayouts: {}, activeLayout: null },
    mcp: { ...DEFAULT_MCP_SETTINGS },
  };
}

/** Explicit reset path used by POST /api/settings/reset and the settings UI's "Restore defaults". */
export function resetToDefaults(): AppSettings {
  return defaultSettings();
}

/* --------------------------------- validation ------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const CUSTOM_COLOR_KEYS = ["accent", "background", "foreground", "muted", "border"] as const;

/**
 * Parse one mode's custom colour overrides. `undefined` means "field absent" so the caller keeps
 * its default (this is what lets version-1 JSON without a dark variant gain the default on read);
 * strict mode rejects malformed values, tolerant mode drops them.
 */
function parseCustomColors(value: unknown, name: string, strict: boolean): CustomColors | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) {
    if (strict) fail(`${name} must be an object or null`);
    return undefined;
  }
  const colors: CustomColors = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!(CUSTOM_COLOR_KEYS as readonly string[]).includes(key)) continue;
    if (typeof candidate === "string" && HEX_COLOR.test(candidate)) colors[key as keyof CustomColors] = candidate;
    else if (strict) fail(`${name}.${key} must be a hex color`);
  }
  return Object.keys(colors).length ? colors : null;
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T, strict: boolean): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  if (strict) fail(`${name} must be one of: ${allowed.join(", ")}`);
  return fallback;
}

function boundedNumber(value: unknown, name: string, min: number, max: number, fallback: number, strict: boolean): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
  if (strict) fail(`${name} must be a number between ${min} and ${max}`);
  return fallback;
}

function widgetFromInput(value: unknown, fallback: WidgetPreference, strict: boolean): WidgetPreference {
  if (!isRecord(value)) {
    if (strict) fail("widget preference must be an object");
    return fallback;
  }
  if (value.visible !== undefined && typeof value.visible !== "boolean" && strict) {
    fail("widget.visible must be a boolean");
  }
  return {
    visible: typeof value.visible === "boolean" ? value.visible : fallback.visible,
    order: boundedNumber(value.order, "widget.order", 0, 1000, fallback.order, strict),
    size: oneOf(value.size, "widget.size", WIDGET_SIZES, fallback.size, strict),
    range: oneOf(value.range, "widget.range", WIDGET_RANGES, fallback.range, strict),
    display: oneOf(value.display, "widget.display", WIDGET_DISPLAYS, fallback.display, strict),
  };
}

/**
 * Parse settings. `strict` (PUT) rejects garbage with a ValidationError; tolerant (stored reads)
 * drops bad fields to defaults. Unknown top-level and widget keys are ignored, never stored.
 */
function parseSettings(value: unknown, strict: boolean): AppSettings {
  if (!isRecord(value)) {
    if (strict) fail("settings must be an object");
    return defaultSettings();
  }
  const base = defaultSettings();
  const appearance = value.appearance === undefined ? {} : value.appearance;
  const dashboard = value.dashboard === undefined ? {} : value.dashboard;
  if (!isRecord(appearance)) {
    if (strict) fail("settings.appearance must be an object");
  }
  if (!isRecord(dashboard)) {
    if (strict) fail("settings.dashboard must be an object");
  }
  const aIn = isRecord(appearance) ? appearance : {};
  const dIn = isRecord(dashboard) ? dashboard : {};
  const a = base.appearance;

  a.mode = oneOf(aIn.mode, "appearance.mode", THEME_MODES, a.mode, strict);
  a.density = oneOf(aIn.density, "appearance.density", DENSITIES, a.density, strict);
  a.cornerStyle = oneOf(aIn.cornerStyle, "appearance.cornerStyle", CORNER_STYLES, a.cornerStyle, strict);
  a.chartPalette = oneOf(aIn.chartPalette, "appearance.chartPalette", CHART_PALETTES, a.chartPalette, strict);
  a.fontSize = boundedNumber(aIn.fontSize, "appearance.fontSize", 12, 20, a.fontSize, strict);
  if (aIn.preset !== undefined) {
    if (typeof aIn.preset === "string" && aIn.preset.length > 0 && aIn.preset.length <= 40) a.preset = aIn.preset;
    else if (strict) fail("appearance.preset must be a 1–40 character string");
  }
  const lightColors = parseCustomColors(aIn.customColors, "appearance.customColors", strict);
  if (lightColors !== undefined) a.customColors = lightColors;
  const darkColors = parseCustomColors(aIn.customColorsDark, "appearance.customColorsDark", strict);
  if (darkColors !== undefined) a.customColorsDark = darkColors;

  const d = base.dashboard;
  if (dIn.widgets !== undefined) {
    if (!isRecord(dIn.widgets)) {
      if (strict) fail("dashboard.widgets must be an object");
    } else {
      for (const id of WIDGET_IDS) {
        d.widgets[id] = widgetFromInput(dIn.widgets[id], d.widgets[id], strict);
      }
    }
  }
  if (dIn.namedLayouts !== undefined) {
    if (!isRecord(dIn.namedLayouts)) {
      if (strict) fail("dashboard.namedLayouts must be an object");
    } else {
      for (const [key, raw] of Object.entries(dIn.namedLayouts).slice(0, 20)) {
        if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 40 || !isRecord(raw.widgets)) {
          if (strict) fail(`dashboard.namedLayouts.${key} must have a name and widgets`);
          continue;
        }
        const widgets: Record<string, WidgetPreference> = {};
        for (const id of WIDGET_IDS) {
          widgets[id] = widgetFromInput(raw.widgets[id], defaultWidget(WIDGET_IDS.indexOf(id) + 1), strict);
        }
        d.namedLayouts[key.slice(0, 40)] = { name: raw.name, widgets };
      }
    }
  }
  if (dIn.activeLayout !== undefined && dIn.activeLayout !== null) {
    if (typeof dIn.activeLayout === "string" && dIn.activeLayout in d.namedLayouts) d.activeLayout = dIn.activeLayout;
    else if (strict) fail("dashboard.activeLayout must name a saved layout or be null");
  }

  // Older stored JSON (version 1) has no `mcp` section; both booleans inherit the defaults above.
  const mcpIn = value.mcp === undefined ? {} : value.mcp;
  if (!isRecord(mcpIn)) {
    if (strict) fail("settings.mcp must be an object");
  }
  const mIn = isRecord(mcpIn) ? mcpIn : {};
  const m: McpSettings = { ...(base.mcp ?? DEFAULT_MCP_SETTINGS) };
  if (mIn.enabled !== undefined) {
    if (typeof mIn.enabled === "boolean") m.enabled = mIn.enabled;
    else if (strict) fail("settings.mcp.enabled must be a boolean");
  }
  if (mIn.lanEnabled !== undefined) {
    if (typeof mIn.lanEnabled === "boolean") m.lanEnabled = mIn.lanEnabled;
    else if (strict) fail("settings.mcp.lanEnabled must be a boolean");
  }
  base.mcp = m;
  return base;
}

/** Strict parse for PUT. Throws ValidationError on malformed input; unknown keys are ignored. */
export function validateSettingsInput(value: unknown): AppSettings {
  return parseSettings(value, true);
}

/** Tolerant parse for stored JSON. Never throws; malformed fields fall back to defaults. */
export function coerceStoredSettings(value: unknown): AppSettings {
  return isRecord(value) && value.version === 1 ? parseSettings(value, false) : defaultSettings();
}

/* --------------------------------- persistence ----------------------------------------------- */

function snapshot(value: AppSettings, revision: number, updatedAtMs: number): SettingsSnapshot {
  return { value, revision, updatedAtMs };
}

function readRow(): { value: string; revision: number; updatedAtMs: number } | null {
  const row = sqlite
    .prepare("SELECT value, revision, updated_at_ms FROM app_settings WHERE id = 1")
    .get() as { value: string; revision: number; updated_at_ms: number } | undefined;
  if (!row) return null;
  return { value: row.value, revision: row.revision, updatedAtMs: row.updated_at_ms };
}

/** Read the singleton. A missing or corrupt row yields defaults at revision 0 (no write). */
export function getSettings(): SettingsSnapshot {
  const row = readRow();
  if (!row) return snapshot(defaultSettings(), 0, 0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = null;
  }
  return snapshot(coerceStoredSettings(parsed), row.revision, row.updatedAtMs);
}

function writeSettings(current: SettingsSnapshot, expectedRevision: number, value: AppSettings): SettingsSnapshot {
  if (current.revision !== expectedRevision) {
    throw new SettingsConflictError(
      `Settings changed on another device (expected revision ${expectedRevision}, found ${current.revision}); reload and try again`,
    );
  }
  const now = Date.now();
  if (current.updatedAtMs === 0) {
    sqlite
      .prepare("INSERT INTO app_settings (id, value, revision, updated_at_ms) VALUES (1, ?, ?, ?)")
      .run(JSON.stringify(value), current.revision + 1, now);
  } else {
    const result = sqlite
      .prepare("UPDATE app_settings SET value = ?, revision = ?, updated_at_ms = ? WHERE id = 1 AND revision = ?")
      .run(JSON.stringify(value), current.revision + 1, now, expectedRevision);
    if (result.changes !== 1) {
      throw new SettingsConflictError("Settings changed concurrently; reload and try again");
    }
  }
  return getSettings();
}

/** Replace the whole settings object with revision-checked optimistic concurrency. */
export function updateSettings(input: AppSettings, expectedRevision: number): SettingsSnapshot {
  return sqlite.transaction(() => writeSettings(getSettings(), expectedRevision, input)).immediate();
}

/** Restore defaults with the same concurrency guard; a missing revision means "current". */
export function resetSettings(expectedRevision?: number): SettingsSnapshot {
  return sqlite.transaction(() => {
    const current = getSettings();
    return writeSettings(current, expectedRevision ?? current.revision, defaultSettings());
  }).immediate();
}

/** Map service errors to an HTTP status for the settings routes. */
export function settingsErrorStatus(error: unknown): number {
  if (error instanceof SettingsConflictError) return 409;
  if (error instanceof ValidationError) return error.status;
  return 500;
}
