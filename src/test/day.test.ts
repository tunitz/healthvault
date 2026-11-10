import { expect, test } from "bun:test";
import {
  addDays,
  formatLocal,
  isDay,
  lastDays,
  localDay,
  localDayWindow,
  localTimeMs,
  weekStart,
  weekdayIndex,
} from "@/lib/day";

test("localDay follows the zone, not UTC", () => {
  const ms = Date.parse("2026-11-09T15:30:00Z"); // 23:30 in Shanghai
  expect(localDay(ms, "Asia/Shanghai")).toBe("2026-11-09");
  expect(localDay(ms, "UTC")).toBe("2026-11-09");
  // 16:30Z is already the next calendar day in Shanghai
  expect(localDay(Date.parse("2026-11-09T16:30:00Z"), "Asia/Shanghai")).toBe("2026-11-10");
  expect(localDay(Date.parse("2026-11-09T16:30:00Z"), "UTC")).toBe("2026-11-09");
});

test("a local day window round-trips through localDay", () => {
  for (const tz of ["Asia/Shanghai", "UTC", "America/New_York", "Europe/Berlin"]) {
    const { startMs, endMs } = localDayWindow("2026-03-08", tz);
    expect(localDay(startMs, tz)).toBe("2026-03-08");
    expect(localDay(endMs - 1, tz)).toBe("2026-03-08");
    expect(localDay(endMs, tz)).toBe("2026-03-09");
    expect(endMs - startMs).toBeGreaterThan(22 * 3600_000);
    expect(endMs - startMs).toBeLessThan(26 * 3600_000);
  }
});

test("localTimeMs builds the same instant the zone reports", () => {
  const ms = localTimeMs("2026-11-09", "19:39", "Asia/Shanghai");
  expect(formatLocal(ms, "Asia/Shanghai")).toBe("2026-11-09 19:39");
  expect(new Date(ms).toISOString()).toBe("2026-11-09T11:39:00.000Z");
});

test("addDays and weeks are calendar-safe", () => {
  expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 2026 is not a leap year
  expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  expect(weekdayIndex("2026-11-08")).toBe(0); // Sunday
  expect(weekStart("2026-11-10")).toBe("2026-11-08");
  expect(lastDays(3, "2026-11-10")).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
});

test("isDay rejects impossible dates instead of normalising them", () => {
  for (const day of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-11-31", "2026-13-01", "2026-1-1"]) {
    expect(isDay(day)).toBe(false);
  }
  for (const day of ["2026-02-28", "2026-03-01", "2026-12-31"]) expect(isDay(day)).toBe(true);
});

test("formatLocal never claims UTC", () => {
  const ms = Date.parse("2026-11-09T11:39:00Z");
  expect(formatLocal(ms, "Asia/Shanghai")).toBe("2026-11-09 19:39");
  expect(formatLocal(ms, "UTC")).toBe("2026-11-09 11:39");
  expect(formatLocal(null)).toBe("—");
});
