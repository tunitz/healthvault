import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadForm } from "@/components/upload-form";
import { recentUploads } from "@/db/queries";
import { bytes, instant, num } from "@/lib/format";
import { getTimezone } from "@/lib/services/profile";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Import" };

const STEPS = [
  { n: "1", title: "Export on the iPhone", body: "Health app → your picture → Export All Health Data." },
  { n: "2", title: "Bring it here", body: "The zip is read once and never stored." },
  { n: "3", title: "Drop it below", body: "Re-importing is safe: stored rows are skipped." },
];

const statusVariant = (status: string) =>
  status === "done" ? "default" : status === "failed" ? "destructive" : "secondary";

export default function UploadsPage() {
  const uploads = recentUploads();
  const timezone = getTimezone();
  const last = uploads[0];

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
        <p className="text-sm text-muted-foreground">
          Apple Health export → database. The zip is parsed in memory and duplicates are skipped.
        </p>
      </div>

      <ol className="grid gap-6 sm:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="flex flex-col gap-1 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">Step {s.n}</p>
            <p className="text-sm font-medium">{s.title}</p>
            <p className="text-xs text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Import an export</h2>
          <p className="text-xs text-muted-foreground">
            {last && last.status === "done"
              ? `Last import: ${num(last.recordsInserted)} rows on ${instant(last.createdAtMs, timezone)}.`
              : "No successful import yet."}
          </p>
        </div>
        <UploadForm />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Import history</h2>
          <p className="text-xs text-muted-foreground">Newest first, capped at 50.</p>
        </div>
        {uploads.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No imports yet. Start with step 1, then{" "}
            <Link className="text-primary underline underline-offset-4" href="/training">check Training</Link>.
          </p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border/60 md:hidden">
              {uploads.map((u, i) => (
                <li key={`${u.createdAtMs}-${i}`} className="flex flex-col gap-1 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{u.filename}</p>
                      <p className="num text-xs text-muted-foreground">{instant(u.createdAtMs, timezone)}</p>
                    </div>
                    <Badge variant={statusVariant(u.status)}>{u.status}</Badge>
                  </div>
                  <p className="num text-xs text-muted-foreground">
                    {bytes(u.bytes)} · {num(u.recordsInserted)} inserted · {num(u.recordsDuplicates)} duplicates
                  </p>
                  {u.message ? (
                    <p className="break-words text-xs text-muted-foreground">{u.message}</p>
                  ) : null}
                </li>
              ))}
            </ul>

            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Inserted</TableHead>
                    <TableHead className="text-right">Duplicates</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uploads.map((u, i) => (
                    <TableRow key={`${u.createdAtMs}-${i}`}>
                      <TableCell className="num text-muted-foreground">{instant(u.createdAtMs, timezone)}</TableCell>
                      <TableCell className="max-w-[220px] truncate">{u.filename}</TableCell>
                      <TableCell className="num text-right">{bytes(u.bytes)}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(u.status)}>{u.status}</Badge>
                      </TableCell>
                      <TableCell className="num text-right">{num(u.recordsInserted)}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">{num(u.recordsDuplicates)}</TableCell>
                      <TableCell className="max-w-[280px] truncate text-muted-foreground">{u.message ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
