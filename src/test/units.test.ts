import { describe, expect, test } from "bun:test";
import {
  formatDistance,
  formatHeight,
  formatPace,
  formatWaist,
  formatWeight,
  formatWeightDelta,
  paceUnitLabel,
  toCanonicalDistance,
  toCanonicalWaist,
  toCanonicalWeight,
  toDisplayDistance,
  toDisplayPace,
  toDisplayWaist,
  toDisplayWeight,
  weightUnit,
} from "@/lib/units";

describe("weight", () => {
  test("metric is canonical", () => {
    expect(toDisplayWeight(79, "metric")).toBe(79);
    expect(toCanonicalWeight(79, "metric")).toBe(79);
    expect(weightUnit("metric")).toBe("kg");
  });

  test("imperial converts both ways", () => {
    expect(toDisplayWeight(100, "imperial")).toBeCloseTo(220.462, 3);
    expect(toCanonicalWeight(220.462, "imperial")).toBeCloseTo(100, 3);
    expect(weightUnit("imperial")).toBe("lb");
  });

  test("formats with the preferred unit and trims false precision", () => {
    expect(formatWeight(79, "metric")).toBe("79 kg");
    expect(formatWeight(79, "imperial")).toBe("174.2 lb");
    expect(formatWeight(79, "metric", 0)).toBe("79 kg");
    expect(formatWeight(null, "metric")).toBe("—");
    expect(formatWeightDelta(1.2, "metric")).toBe("+1.2 kg");
    expect(formatWeightDelta(-1.2, "metric")).toBe("-1.2 kg");
  });
});

describe("waist and height", () => {
  test("waist converts cm and inches", () => {
    expect(toDisplayWaist(90, "imperial")).toBeCloseTo(35.433, 3);
    expect(toCanonicalWaist(35.433, "imperial")).toBeCloseTo(90, 3);
    expect(formatWaist(90, "metric")).toBe("90 cm");
    expect(formatWaist(90, "imperial")).toBe("35.4 in");
  });

  test("height is cm or feet and inches", () => {
    expect(formatHeight(163, "metric")).toBe("163 cm");
    expect(formatHeight(163, "imperial")).toBe("5′ 4″");
    expect(formatHeight(182.88, "imperial")).toBe("6′ 0″");
    expect(formatHeight(null, "imperial")).toBe("—");
  });
});

describe("distance and pace", () => {
  test("distance converts km to miles", () => {
    expect(toDisplayDistance(10, "imperial")).toBeCloseTo(6.2137, 3);
    expect(toCanonicalDistance(6.2137, "imperial")).toBeCloseTo(10, 3);
    expect(formatDistance(10, "metric")).toBe("10 km");
    expect(formatDistance(10, "imperial")).toBe("6.2 mi");
    expect(formatDistance(null, "imperial")).toBe("—");
  });

  test("pace converts minutes per km to minutes per mile", () => {
    expect(toDisplayPace(5, "imperial")).toBeCloseTo(8.0467, 3);
    expect(paceUnitLabel("metric")).toBe("/km");
    expect(paceUnitLabel("imperial")).toBe("/mi");
    expect(formatPace(5, "metric")).toBe("5 /km");
    expect(formatPace(5, "imperial")).toBe("8.05 /mi");
    expect(formatPace(null, "metric")).toBe("—");
  });
});
