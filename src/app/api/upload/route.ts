import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { uploads } from "@/db/schema";
import { requireSessionOr401 } from "@/lib/auth";
import { runIngest } from "@/lib/ingest";

export const runtime = "nodejs";
/**
 * Cap on the *zip* (the inflated XML has its own cap in `lib/ingest.ts`). Exported because the
 * proxy body buffer in `next.config.ts` must stay above it — see `src/test/upload-body-limit.test.ts`.
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Live progress polling endpoint for an active import. */
export async function GET() {
  const denied = await requireSessionOr401();
  if (denied) return denied;
  const latest = db
    .select({
      id: uploads.id,
      filename: uploads.filename,
      status: uploads.status,
      rowsProcessed: uploads.rowsProcessed,
      recordsInserted: uploads.recordsInserted,
      recordsDuplicates: uploads.recordsDuplicates,
      createdAtMs: uploads.createdAtMs,
      finishedAtMs: uploads.finishedAtMs,
    })
    .from(uploads)
    .orderBy(desc(uploads.id))
    .limit(1)
    .get();
  return NextResponse.json(
    { latest: latest ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const denied = await requireSessionOr401();
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field required" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "zip larger than 200MB" }, { status: 413 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await runIngest(bytes, file.name, file.size);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
