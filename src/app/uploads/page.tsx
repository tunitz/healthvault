import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadForm } from "@/components/upload-form";
import { recentUploads } from "@/db/queries";
import { bytes, instant, num } from "@/lib/format";

export const dynamic = "force-dynamic";

const variant = (status: string) =>
  status === "done" ? "default" : status === "failed" ? "destructive" : "secondary";

export default function UploadsPage() {
  const uploads = recentUploads();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Uploads</h1>
        <p className="text-sm text-muted-foreground">
          Re-uploading the same export is safe: duplicates are skipped, new rows are appended.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Import an export</CardTitle>
          <CardDescription>
            Health app → profile picture → Export All Health Data → save the Export.zip, then pick it here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UploadForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upload history</CardTitle>
          <CardDescription>Newest first, capped at 50 uploads</CardDescription>
        </CardHeader>
        <CardContent>
          {uploads.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No uploads yet.</p>
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
                    <TableCell className="tabular-nums">{instant(u.createdAtMs)}</TableCell>
                    <TableCell className="max-w-[220px] truncate">{u.filename}</TableCell>
                    <TableCell className="text-right tabular-nums">{bytes(u.bytes)}</TableCell>
                    <TableCell>
                      <Badge variant={variant(u.status)}>{u.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{num(u.recordsInserted)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(u.recordsDuplicates)}</TableCell>
                    <TableCell className="max-w-[280px] truncate text-muted-foreground">
                      {u.message ?? "—"}
                    </TableCell>
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
