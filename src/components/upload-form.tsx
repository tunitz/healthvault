"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type Result = {
  inserted: number;
  duplicates: number;
  routesInserted?: number;
  ecgsInserted?: number;
  filename: string;
};

const readable = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [rowsProcessed, setRowsProcessed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startedAtRef = useRef<number>(0);
  const router = useRouter();

  // Poll `/api/upload` while an import is running so a large export displays live rows parsed.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    startedAtRef.current = started;
    const clock = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    let cancelled = false;
    const poll = setInterval(() => {
      fetch("/api/upload", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ latest?: { status?: string; rowsProcessed?: number; createdAtMs?: number } | null }>) : null))
        .then((body) => {
          if (cancelled || !body?.latest) return;
          if ((body.latest.createdAtMs ?? 0) >= started - 5000 && typeof body.latest.rowsProcessed === "number") {
            setRowsProcessed(body.latest.rowsProcessed);
          }
        })
        .catch(() => {
          // Best-effort live counter; main POST reports real errors.
        });
    }, 750);
    return () => {
      cancelled = true;
      clearInterval(clock);
      clearInterval(poll);
    };
  }, [busy]);

  function pick(next: File | null) {
    setResult(null);
    if (!next) { setFile(null); return; }
    if (!/\.zip$/i.test(next.name)) {
      toast.error("That is not a .zip", { description: "Pick the Export.zip produced by the Health app." });
      return;
    }
    setFile(next);
  }

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    setElapsed(0);
    setRowsProcessed(0);
    setResult(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        toast.error("Import failed", { description: body.error ?? `HTTP ${res.status}` });
      } else {
        setResult({
          inserted: body.inserted,
          duplicates: body.duplicates,
          routesInserted: body.routesInserted,
          ecgsInserted: body.ecgsInserted,
          filename: file.name,
        });
        toast.success(`Imported ${body.inserted.toLocaleString("en-US")} rows`);
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
        router.refresh();
      }
    } catch (e) {
      toast.error("Import failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files?.[0] ?? null);
        }}
        className={`flex w-full flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-10 text-center transition-colors sm:px-6 ${
          dragging ? "border-primary bg-primary/5" : "border-border"
        }`}
      >
        <p className="text-sm font-medium">
          {file ? file.name : "Drop Export.zip here"}
        </p>
        <p className="text-xs text-muted-foreground">
          {file
            ? readable(file.size)
            : "or choose the file — imports records, workouts, GPX routes, and ECG strips"}
        </p>
        <input
          ref={inputRef}
          id="export-file"
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
          className="sr-only"
        />
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          <Button variant="outline" asChild>
            <label htmlFor="export-file" className="cursor-pointer">Choose file</label>
          </Button>
          <Button onClick={submit} disabled={!file || busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy
              ? rowsProcessed > 0
                ? `Parsed ${rowsProcessed.toLocaleString("en-US")} rows · ${elapsed}s`
                : `Uploading & parsing… ${elapsed}s`
              : "Import"}
          </Button>
        </div>
        {busy ? (
          <div className="flex w-full max-w-sm flex-col gap-1" role="status" aria-live="polite">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
            </div>
            <p className="num text-[11px] text-muted-foreground">
              {rowsProcessed > 0
                ? `${rowsProcessed.toLocaleString("en-US")} rows processed so far…`
                : "Reading export.xml, routes, and ECG strips…"}
            </p>
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="flex flex-col gap-1 border-l-2 border-primary pl-4">
          <p className="text-sm font-medium">
            Imported {result.inserted.toLocaleString("en-US")} rows from {result.filename}
          </p>
          <p className="text-xs text-muted-foreground">
            {result.duplicates > 0
              ? `${result.duplicates.toLocaleString("en-US")} rows were already present and were skipped.`
              : "Nothing was duplicated."}
            {result.routesInserted ? ` · ${result.routesInserted} GPX routes` : ""}
            {result.ecgsInserted ? ` · ${result.ecgsInserted} ECG strips` : ""}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button asChild size="sm">
              <Link href="/training">See training</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/workouts">View workouts</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
