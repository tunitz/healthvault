/**
 * Client-safe widget registry for the configurable dashboard.
 *
 * The ids and value unions mirror `src/lib/services/settings.ts` (which imports the database and
 * must never be pulled into a client bundle). Keep this list in step with that service.
 */
import type { WidgetDisplay, WidgetRange, WidgetSize } from "@/lib/services/settings";

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
export type WidgetId = (typeof WIDGET_IDS)[number];

export type WidgetPreference = {
  visible: boolean;
  order: number;
  size: WidgetSize;
  range: WidgetRange;
  display: WidgetDisplay;
};

export type WidgetMeta = {
  id: WidgetId;
  title: string;
  description: string;
  /** Views that make sense for this widget. Summary is always allowed. */
  displays: readonly WidgetDisplay[];
  defaultSize: WidgetSize;
};

/** The single source of truth for which views each widget may use. A view change is a rendering
 *  choice only — the data, units, missing-data treatment and freshness never depend on it. */
export const WIDGET_REGISTRY: readonly WidgetMeta[] = [
  {
    id: "nutrition",
    title: "Nutrition",
    description: "Today's calories and macros against targets",
    displays: ["summary", "table"],
    defaultSize: "medium",
  },
  {
    id: "activity",
    title: "Activity",
    description: "Steps and active energy over time",
    displays: ["summary", "table", "line", "area", "bars"],
    defaultSize: "large",
  },
  {
    id: "supplements",
    title: "Supplements",
    description: "Today's checklist or weekly adherence",
    displays: ["summary", "table", "checklist", "adherence"],
    defaultSize: "medium",
  },
  {
    id: "measurements",
    title: "Measurements",
    description: "Manual and Apple body measurements",
    displays: ["summary", "table", "line", "area"],
    defaultSize: "medium",
  },
  {
    id: "sleep",
    title: "Sleep",
    description: "Asleep duration or stage breakdown",
    displays: ["summary", "table", "duration", "stages"],
    defaultSize: "large",
  },
  {
    id: "weight",
    title: "Weight",
    description: "Weight trend and latest reading",
    displays: ["summary", "table", "line", "area"],
    defaultSize: "medium",
  },
  {
    id: "workouts",
    title: "Workouts",
    description: "Sessions, distance and duration",
    displays: ["summary", "table", "bars"],
    defaultSize: "medium",
  },
  {
    id: "training",
    title: "Training",
    description: "This week's running, strength and recovery",
    displays: ["summary", "table"],
    defaultSize: "medium",
  },
  {
    id: "imports",
    title: "Imports",
    description: "Last successful Apple Health import and recent attempts",
    displays: ["summary", "table"],
    defaultSize: "small",
  },
] as const;

export const WIDGET_META: Record<WidgetId, WidgetMeta> = Object.fromEntries(
  WIDGET_REGISTRY.map((meta) => [meta.id, meta]),
) as Record<WidgetId, WidgetMeta>;

export const RANGES: readonly WidgetRange[] = ["7d", "30d", "90d", "1y"] as const;
export const RANGE_LABELS: Record<WidgetRange, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
};
export const RANGE_DAYS: Record<WidgetRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export const SIZES: readonly WidgetSize[] = ["small", "medium", "large"] as const;
export const SIZE_LABELS: Record<WidgetSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** Tailwind grid spans. Phones get one column; larger screens use the chosen size. */
export const SIZE_SPAN: Record<WidgetSize, string> = {
  small: "col-span-1",
  medium: "col-span-1 sm:col-span-2 xl:col-span-2",
  large: "col-span-1 sm:col-span-2 xl:col-span-4",
};

export const DISPLAY_LABELS: Record<WidgetDisplay, string> = {
  summary: "Summary",
  table: "Table",
  line: "Line chart",
  area: "Area chart",
  bars: "Bar chart",
  checklist: "Checklist",
  adherence: "Adherence",
  stages: "Sleep stages",
  duration: "Sleep duration",
};

export function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === "string" && (WIDGET_IDS as readonly string[]).includes(value);
}

/** A saved display is only honoured when the widget allows it; otherwise fall back to summary. */
export function allowedDisplay(id: WidgetId, display: WidgetDisplay): WidgetDisplay {
  const meta = WIDGET_META[id];
  return meta.displays.includes(display) ? display : "summary";
}

/**
 * Deterministic placement: visible widgets in ascending order, ties broken by registry order.
 * The same ordering is used on every device; only the grid geometry changes with width.
 */
export function orderedVisibleWidgets(
  widgets: Record<string, WidgetPreference>,
): { id: WidgetId; pref: WidgetPreference }[] {
  return WIDGET_IDS.filter((id) => widgets[id]?.visible)
    .map((id) => ({ id, pref: widgets[id] }))
    .sort((a, b) => a.pref.order - b.pref.order || WIDGET_IDS.indexOf(a.id) - WIDGET_IDS.indexOf(b.id));
}
