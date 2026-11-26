/**
 * Client-safe copies of the server defaults (the authoritative versions live in
 * `src/lib/services/settings.ts`). Used only to populate a draft for "Restore defaults";
 * the server validates and stores whatever is finally PUT.
 */
import type { AppSettings, DashboardSettings, WidgetPreference } from "@/lib/services/settings";
import { WIDGET_IDS } from "./registry";

export function defaultAppearance(): AppSettings["appearance"] {
  return {
    mode: "system",
    preset: "default",
    customColors: null,
    density: "comfortable",
    fontSize: 14,
    cornerStyle: "rounded",
    chartPalette: "default",
  };
}

export function defaultWidgetPrefs(): Record<string, WidgetPreference> {
  const widgets: Record<string, WidgetPreference> = {};
  WIDGET_IDS.forEach((id, index) => {
    widgets[id] = { visible: true, order: index + 1, size: "medium", range: "30d", display: "summary" };
  });
  return widgets;
}

export function defaultDashboard(): DashboardSettings {
  return { widgets: defaultWidgetPrefs(), namedLayouts: {}, activeLayout: null };
}

export function defaultAppSettings(): AppSettings {
  return { version: 1, appearance: defaultAppearance(), dashboard: defaultDashboard() };
}
