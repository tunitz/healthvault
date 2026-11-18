/**
 * Focused tests for the optional `sections` filter on healthvault_context. Uses a synthetic
 * full context so the filter is tested in isolation from the database queries that build it.
 */
import { describe, expect, test } from "bun:test";
import {
  selectContextSections,
  type HealthContext,
} from "@/lib/services/context";

const FULL_KEYS = [
  "generatedAt",
  "today",
  "timezone",
  "profile",
  "nutrition",
  "weight",
  "supplements",
  "nextSupplement",
  "strength",
  "training",
  "data",
] as const;

function fakeContext(): HealthContext {
  return Object.fromEntries(FULL_KEYS.map((key) => [key, { marker: key }])) as unknown as HealthContext;
}

describe("selectContextSections", () => {
  test("omitted or empty sections return the full context", () => {
    const full = fakeContext();
    expect(selectContextSections(full, undefined)).toBe(full);
    expect(selectContextSections(full, [])).toBe(full);
    expect(Object.keys(selectContextSections(full, undefined)).sort()).toEqual([...FULL_KEYS].sort());
  });

  test("a single section returns only that part", () => {
    const full = fakeContext();
    const result = selectContextSections(full, ["nutrition"]);
    expect(Object.keys(result)).toEqual(["nutrition"]);
    expect((result as Record<string, unknown>).nutrition).toEqual({ marker: "nutrition" });
  });

  test("related keys travel with their section", () => {
    const full = fakeContext();
    expect(Object.keys(selectContextSections(full, ["today"])).sort()).toEqual(
      ["generatedAt", "timezone", "today"].sort(),
    );
    expect(Object.keys(selectContextSections(full, ["supplements"])).sort()).toEqual(
      ["nextSupplement", "supplements"].sort(),
    );
    expect(Object.keys(selectContextSections(full, ["training"])).sort()).toEqual(
      ["strength", "training"].sort(),
    );
  });

  test("unknown names are ignored; only unknown names fall back to full", () => {
    const full = fakeContext();
    expect(Object.keys(selectContextSections(full, ["nutrition", "bogus"]))).toEqual(["nutrition"]);
    expect(selectContextSections(full, ["bogus"])).toBe(full);
  });
});
