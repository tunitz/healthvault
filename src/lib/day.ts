/**
 * Local-calendar-day helpers.
 *
 * Apple writes each record's `day` in the export's local time (+08:00 here), but SQLite's
 * `date('now')` is UTC. Mixing the two shifts the "last 30 days" window by 8 hours and makes
 * today's rows disappear at the wrong moment. Every day boundary in the app goes through
 * these helpers with the profile's IANA timezone instead.
 *
 * This module is deliberately dependency-free so client components can import it.
 */

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsInZone(ms: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** IANA offset (ms east of UTC) in effect at `ms`. */
function offsetAt(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = partsInZone(whole, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

export function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  // Date.parse normalises 2026-02-30 to March; a round-trip rejects impossible dates that
  // would otherwise be stored and then never match a window.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Local calendar day ("YYYY-MM-DD") of an instant in a zone. */
export function localDay(ms: number = Date.now(), tz: string = DEFAULT_TIMEZONE): string {
  const p = partsInZone(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Epoch ms of local midnight starting `day`. Handles DST by solving the offset twice. */
export function localDayStartMs(day: string, tz: string = DEFAULT_TIMEZONE): number {
  const naive = Date.parse(`${day}T00:00:00Z`);
  const first = naive - offsetAt(naive, tz);
  return naive - offsetAt(first, tz);
}

export function localDayEndMs(day: string, tz: string = DEFAULT_TIMEZONE): number {
  return localDayStartMs(addDays(day, 1), tz);
}

export function localDayWindow(day: string, tz: string = DEFAULT_TIMEZONE): { startMs: number; endMs: number } {
  return { startMs: localDayStartMs(day, tz), endMs: localDayEndMs(day, tz) };
}

/** Epoch ms for a wall-clock time ("HH:mm") on a local day. */
export function localTimeMs(day: string, time: string, tz: string = DEFAULT_TIMEZONE): number {
  const m = time.match(/^(\d{2}):(\d{2})$/);
  const naive = Date.parse(`${day}T${m ? `${m[1]}:${m[2]}` : "00:00"}:00Z`);
  const first = naive - offsetAt(naive, tz);
  return naive - offsetAt(first, tz);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, matching Date#getDay and Apple's activity summaries. */
export function weekdayIndex(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** Start of the Sunday-based week containing `day`. */
export function weekStart(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** Newest-last inclusive list of the `n` days ending at `end`. */
export function lastDays(n: number, end: string = localDay()): string[] {
  return Array.from({ length: n }, (_, i) => addDays(end, i - (n - 1)));
}

/** "2026-11-09 19:39" in the local zone (no UTC suffix, unlike the old display). */
export function formatLocal(ms: number | null | undefined, tz: string = DEFAULT_TIMEZONE): string {
  if (!ms) return "—";
  const p = partsInZone(ms, tz);
  const two = (v: number) => String(v).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

export function formatClock(ms: number | null | undefined, tz: string = DEFAULT_TIMEZONE): string {
  if (!ms) return "—";
  const p = partsInZone(ms, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Wall-clock "HH:mm" right now in a zone. Kept here so server components never call
 * `Date.now()` during render (which React flags as unstable output). */
export function localClockNow(tz: string = DEFAULT_TIMEZONE): string {
  return formatClock(Date.now(), tz);
}
