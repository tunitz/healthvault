import { DEFAULT_TIMEZONE, formatLocal } from "@/lib/day";

/** Numbers are shown with at most 2 decimals: no 7.866600000000001 in a tooltip, and no
 * forced trailing zeros on whole numbers. `digits` caps the decimals (0 for counts). */
export function num(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Local wall-clock time in the profile's zone (the old version rendered UTC with a
 * misleading " UTC" suffix, so a 19:39 import showed as 11:39). */
export function instant(ms: number | null, tz: string = DEFAULT_TIMEZONE): string {
  if (!ms) return "—";
  return formatLocal(ms, tz);
}

export function minutes(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  return `${Math.round(seconds / 60)} min`;
}

/** Long durations as hours and minutes: 10,000 s -> "2 h 47 min". */
export function duration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Stopwatch-style duration for a goal or attempt: 1800 -> "30:00", 3725 -> "1:02:05".
 *  Unlike `duration`, the seconds stay visible — a 5K target is stated as a clock. */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}

export function typeLabel(identifier: string): string {
  return identifier
    .replace(/^HK(Quantity|Category|Correlation)TypeIdentifier/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
}

export function workoutLabel(identifier: string): string {
  return identifier.replace(/^HKWorkoutActivityType/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Heart-rate intensity band. The zone is carried by a coloured dot; the label stays in
 * neutral foreground text so it keeps its contrast in light mode. */
export function hrZone(hr: number | null | undefined): { label: string; dot: string } {
  if (hr === null || hr === undefined) return { label: "—", dot: "bg-muted-foreground/40" };
  if (hr < 120) return { label: "easy", dot: "bg-emerald-600 dark:bg-emerald-400" };
  if (hr < 145) return { label: "steady", dot: "bg-amber-600 dark:bg-amber-400" };
  if (hr < 165) return { label: "hard", dot: "bg-orange-600 dark:bg-orange-400" };
  return { label: "max", dot: "bg-rose-600 dark:bg-rose-400" };
}

/** At most 2 decimal places, trailing zeros trimmed. User rule: every number in the UI is
 * rounded to 2 dp, no matter how many decimals the database carries. */
export function r2(v: number | null | undefined, digits = 2): string {
  return num(v, digits);
}

/** Count + noun with correct singular/plural: plural(1, "workout") → "1 workout",
 * plural(2, "workout") → "2 workouts". `display` overrides the number text (e.g. compact). */
export function plural(n: number, one: string, many = `${one}s`, display?: string): string {
  return `${display ?? num(n, 0)} ${n === 1 ? one : many}`;
}
