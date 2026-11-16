import { NextResponse } from "next/server";
import { requireSessionOr401 } from "@/lib/auth";
import { runIngest } from "@/lib/ingest";

export const runtime = "nodejs";
/**
 * Cap on the *zip* (the inflated XML has its own cap in `lib/ingest.ts`). Exported because the
 * proxy body buffer in `next.config.ts` must stay above it — see `src/test/upload-body-limit.test.ts`.
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

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
