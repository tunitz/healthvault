import { NextResponse } from "next/server";
import { crossOriginFailure, requireSessionOr401 } from "@/lib/auth";
import { numField, readJson, ValidationError } from "@/lib/validate";
import { resetSettings, settingsErrorStatus } from "@/lib/services/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** POST reset settings to defaults. Optional `{ revision }` keeps the concurrency guard. */
export async function POST(request: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const cross = crossOriginFailure(request);
  if (cross) return NextResponse.json({ error: cross.error }, { status: cross.status, headers: NO_STORE });

  let revision: number | undefined;
  try {
    // An empty body is fine — reset with the current revision.
    if ((request.headers.get("content-length") ?? "") !== "0") {
      const body = await readJson(request);
      if (body.revision !== undefined) {
        revision = numField(body.revision, "revision", { integer: true, min: 0 })!;
      }
    }
  } catch (error) {
    const status = settingsErrorStatus(error);
    const message = error instanceof ValidationError || error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }

  try {
    return NextResponse.json(resetSettings(revision), { headers: NO_STORE });
  } catch (error) {
    const status = settingsErrorStatus(error);
    const message = error instanceof ValidationError || error instanceof Error ? error.message : "Could not reset settings";
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}
