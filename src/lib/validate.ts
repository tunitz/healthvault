import { isDay, isValidTimezone } from "@/lib/day";

/** An error safe to show to the API caller / form; `status` maps to the HTTP code. */
export class ValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

export function fail(message: string, status = 400): never {
  throw new ValidationError(message, status);
}

type StrOpts = { required?: boolean; max?: number; trim?: boolean };

export function str(value: unknown, name: string, opts: StrOpts = {}): string | null {
  if (value === null || value === undefined || value === "") {
    if (opts.required) fail(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") fail(`${name} must be a string`);
  const v = opts.trim === false ? value : value.trim();
  if (!v.length) {
    if (opts.required) fail(`${name} is required`);
    return null;
  }
  if (v.length > (opts.max ?? 500)) fail(`${name} must be at most ${opts.max ?? 500} characters`);
  return v;
}

type NumOpts = { required?: boolean; min?: number; max?: number; integer?: boolean };

export function numField(value: unknown, name: string, opts: NumOpts = {}): number | null {
  if (value === null || value === undefined || value === "") {
    if (opts.required) fail(`${name} is required`);
    return null;
  }
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) fail(`${name} must be a number`);
  if (opts.integer && !Number.isInteger(n)) fail(`${name} must be an integer`);
  if (opts.min !== undefined && n < opts.min) fail(`${name} must be ≥ ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) fail(`${name} must be ≤ ${opts.max}`);
  return n;
}

export function enumField<T extends string>(value: unknown, name: string, allowed: readonly T[], required = true): T | null {
  if (value === null || value === undefined || value === "") {
    if (required) fail(`${name} must be one of: ${allowed.join(", ")}`);
    return null;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function dayField(value: unknown, name = "day", fallback?: string): string {
  if ((value === null || value === undefined || value === "") && fallback) return fallback;
  if (typeof value !== "string" || !isDay(value)) fail(`${name} must be a YYYY-MM-DD date`);
  return value;
}

export function timezoneField(value: unknown): string {
  if (typeof value !== "string" || !isValidTimezone(value)) fail("timezone must be a valid IANA zone (e.g. Asia/Shanghai)");
  return value;
}

export function boolField(value: unknown, name: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  fail(`${name} must be a boolean`);
}

/** JSON columns accept either a JSON string or a plain object/array. */
export function jsonField(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      fail(`${name} must be valid JSON`);
    }
    return value;
  }
  if (typeof value !== "object") fail(`${name} must be an object or JSON string`);
  return JSON.stringify(value);
}

export function idField(value: unknown, name = "id"): number {
  return numField(value, name, { required: true, integer: true, min: 1 })!;
}

/** Body parsing shared by every API route: always JSON, never a surprise HTML error page. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 1_000_000) fail("request body is larger than 1 MB", 413);
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("request body must be a JSON object");
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    fail("request body must be valid JSON");
  }
}
