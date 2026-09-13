export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
