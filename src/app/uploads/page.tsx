import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadForm } from "@/components/upload-form";
import { recentUploads } from "@/db/queries";
import { bytes, instant, num } from "@/lib/format";

export const dynamic = "force-dynamic";

const STEPS = [
  { n: "1", title: "Export on the iPhone", body: "Health app → your picture → Export All Health Data. Save the Export.zip to Files or AirDrop it over." },
  { n: "2", title: "Bring it to this machine", body: "Any way you like — the file is read once and never stored." },
  { n: "3", title: "Drop it below", body: "Rows already in the database are skipped, so re-importing the same export is safe." },
];

const statusClass = (status: string) =>
  status === "done" ? "default" : status === "failed" ? "destructive" : "secondary";

export default function UploadsPage() {
  const uploads = recentUploads();
  const last = uploads[0];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
        <p className="text-sm text-muted-foreground">
          Apple Health export → database. Nothing but <code>data/health.db</code> is written: the zip is parsed
          in memory, the extracted XML is never saved, and duplicates are dropped by a unique index.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((s) => (
          <Card key={s.n} className="border-l-4 border-l-sky-500/60 bg-card/60">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-sky-500/20 text-xs font-semibold text-sky-300">
                  {s.n}
                </span>
                {s.title}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-xs text-muted-foreground">{s.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden border-emerald-500/20 bg-gradient-to-b from-emerald-500/[0.07] to-transparent">
        <CardHeader>
          <CardTitle className="text-emerald-400">Import an export</CardTitle>
          <CardDescription>
            {last && last.status === "done"
              ? `Last import: ${num(last.recordsInserted)} rows on ${instant(last.createdAtMs)}.`
              : "No successful import yet."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UploadForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Import history</CardTitle>
          <CardDescription>
            Newest first, capped at 50. A re-import shows every row as a duplicate — that means it was already
            in the database.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {uploads.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No imports yet. Start with step 1 above, then <Link className="text-emerald-400 underline" href="/training">check the Training page</Link>.
            </p>
          ) : (
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
                    <TableCell className="tabular-nums text-muted-foreground">{instant(u.createdAtMs)}</TableCell>
                    <TableCell className="max-w-[220px] truncate">{u.filename}</TableCell>
                    <TableCell className="text-right tabular-nums">{bytes(u.bytes)}</TableCell>
                    <TableCell>
                      <Badge variant={statusClass(u.status)}>{u.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-300">{num(u.recordsInserted)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{num(u.recordsDuplicates)}</TableCell>
                    <TableCell className="max-w-[280px] truncate text-muted-foreground">{u.message ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
