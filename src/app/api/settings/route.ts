import { NextResponse } from "next/server";
import { crossOriginFailure, requireSessionOr401 } from "@/lib/auth";
import { numField, readJson, ValidationError } from "@/lib/validate";
import {
  getSettings,
  settingsErrorStatus,
  updateSettings,
  validateSettingsInput,
} from "@/lib/services/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET the whole validated settings object plus its revision. Session + Origin checked. */
export async function GET(request: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });
  return NextResponse.json(getSettings(), { headers: NO_STORE });
}

/** PUT replaces the object. `{ value, revision }` — a stale revision is rejected with 409. */
export async function PUT(request: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "content-type must be application/json" }, { status: 415, headers: NO_STORE });
  }

  try {
    const body = await readJson(request);
    const revision = numField(body.revision, "revision", { required: true, integer: true, min: 0 })!;
    const value = validateSettingsInput(body.value);
    return NextResponse.json(updateSettings(value, revision), { headers: NO_STORE });
  } catch (error) {
    const status = settingsErrorStatus(error);
    const message = error instanceof ValidationError || error instanceof Error ? error.message : "Could not save settings";
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}
