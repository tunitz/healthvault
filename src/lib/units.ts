import { formatSeconds, num } from "@/lib/format";

/**
 * Units preference.
 *
 * Stored values are always canonical metric: weight in kg, height/waist in cm,
 * workout distance in km and pace in minutes per km. The profile's `units` field
 * only decides how those values are shown and which unit an input asks for.
 * API/service payloads are never converted.
 */

export type Units = "metric" | "imperial";

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;
export const KM_PER_MI = 1.609344;
const LB_PER_KG = 1 / KG_PER_LB;
const IN_PER_CM = 1 / CM_PER_IN;

export function isUnits(value: unknown): value is Units {
  return value === "metric" || value === "imperial";
}

/** Stored profiles are text columns; anything unexpected falls back to metric. */
export function resolveUnits(value: unknown): Units {
  return value === "imperial" ? "imperial" : "metric";
}

/* Weight ------------------------------------------------------------------- */

export function weightUnit(units: Units): "kg" | "lb" {
  return units === "imperial" ? "lb" : "kg";
}

export function toDisplayWeight(kg: number, units: Units): number {
  return units === "imperial" ? kg * LB_PER_KG : kg;
}

export function toCanonicalWeight(value: number, units: Units): number {
  return units === "imperial" ? value * KG_PER_LB : value;
}

export function formatWeight(
  kg: number | null | undefined,
  units: Units,
  digits = 1,
): string {
  if (kg === null || kg === undefined || Number.isNaN(kg)) return "—";
  return `${num(toDisplayWeight(kg, units), digits)} ${weightUnit(units)}`;
}

/** Signed delta with the unit, e.g. "+1.2 kg" or "−2.6 lb". */
export function formatWeightDelta(
  kg: number | null | undefined,
  units: Units,
  digits = 1,
): string {
  if (kg === null || kg === undefined || Number.isNaN(kg)) return "—";
  const value = toDisplayWeight(kg, units);
  return `${value > 0 ? "+" : ""}${num(value, digits)} ${weightUnit(units)}`;
}

/* Waist -------------------------------------------------------------------- */

export function waistUnit(units: Units): "cm" | "in" {
  return units === "imperial" ? "in" : "cm";
}

export function toDisplayWaist(cm: number, units: Units): number {
  return units === "imperial" ? cm * IN_PER_CM : cm;
}

export function toCanonicalWaist(value: number, units: Units): number {
  return units === "imperial" ? value * CM_PER_IN : value;
}

export function formatWaist(
  cm: number | null | undefined,
  units: Units,
  digits = 1,
): string {
  if (cm === null || cm === undefined || Number.isNaN(cm)) return "—";
  return `${num(toDisplayWaist(cm, units), digits)} ${waistUnit(units)}`;
}

/* Height ------------------------------------------------------------------- */

export function formatHeight(
  cm: number | null | undefined,
  units: Units,
  digits = 0,
): string {
  if (cm === null || cm === undefined || Number.isNaN(cm)) return "—";
  if (units !== "imperial") return `${num(cm, digits)} cm`;
  const totalInches = Math.round(cm / CM_PER_IN);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}′ ${inches}″`;
}

/* Distance and pace -------------------------------------------------------- */

export function distanceUnit(units: Units): "km" | "mi" {
  return units === "imperial" ? "mi" : "km";
}

export function toDisplayDistance(km: number, units: Units): number {
  return units === "imperial" ? km / KM_PER_MI : km;
}

export function toCanonicalDistance(value: number, units: Units): number {
  return units === "imperial" ? value * KM_PER_MI : value;
}

export function formatDistance(
  km: number | null | undefined,
  units: Units,
  digits = 1,
): string {
  if (km === null || km === undefined || Number.isNaN(km)) return "—";
  return `${num(toDisplayDistance(km, units), digits)} ${distanceUnit(units)}`;
}

export function paceUnitLabel(units: Units): "/km" | "/mi" {
  return units === "imperial" ? "/mi" : "/km";
}

export function toDisplayPace(minPerKm: number, units: Units): number {
  return units === "imperial" ? minPerKm * KM_PER_MI : minPerKm;
}

export function formatPace(
  minPerKm: number | null | undefined,
  units: Units,
  digits = 2,
): string {
  if (minPerKm === null || minPerKm === undefined || Number.isNaN(minPerKm)) return "—";
  return `${num(toDisplayPace(minPerKm, units), digits)} ${paceUnitLabel(units)}`;
}

/** Pace written as a clock: 6 min/km -> "6:00 min/km". Used for the 5K goal and attempt
 *  table, where a stated target reads more clearly than a decimal. Charts keep `formatPace`. */
export function formatPaceClock(minPerKm: number | null | undefined, units: Units): string {
  if (minPerKm === null || minPerKm === undefined || Number.isNaN(minPerKm)) return "—";
  const label = units === "imperial" ? "min/mi" : "min/km";
  return `${formatSeconds(toDisplayPace(minPerKm, units) * 60)} ${label}`;
}
