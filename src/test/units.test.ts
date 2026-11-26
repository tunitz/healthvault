import { describe, expect, test } from "bun:test";
import { formatWeight, toCanonicalWeight } from "@/lib/units";

describe("weight display", () => {
  test("preserves hundredths without adding trailing zeros", () => {
    expect(formatWeight(76.25, "metric")).toBe("76.25 kg");
    expect(formatWeight(76.2, "metric")).toBe("76.2 kg");
    expect(formatWeight(77, "metric")).toBe("77 kg");
  });

  test("drops digits after the hundredths without rounding", () => {
    expect(formatWeight(76.259, "metric")).toBe("76.25 kg");
    expect(formatWeight(toCanonicalWeight(176.259, "imperial"), "imperial")).toBe("176.25 lb");
  });

  test("retains hundredths when converting pounds back from storage", () => {
    expect(formatWeight(toCanonicalWeight(176.02, "imperial"), "imperial")).toBe("176.02 lb");
  });
});
