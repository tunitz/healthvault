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

export function instant(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function minutes(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  return `${Math.round(seconds / 60)} min`;
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

/** Heart-rate intensity band. Kept here (not in the chart module, which is a client
 * component) because server components need it too. */
export function hrZone(hr: number | null | undefined): { label: string; className: string } {
  if (hr === null || hr === undefined) return { label: "—", className: "text-muted-foreground" };
  if (hr < 120) return { label: "easy", className: "text-emerald-400" };
  if (hr < 145) return { label: "steady", className: "text-amber-400" };
  if (hr < 165) return { label: "hard", className: "text-orange-400" };
  return { label: "max", className: "text-rose-400" };
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
