"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type Result = { inserted: number; duplicates: number; filename: string };

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
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // A 400 MB export takes ~35 s to parse, and the browser gets no progress events for it:
  // show elapsed time so a long import does not look like a hang.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
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
    setResult(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        toast.error("Import failed", { description: body.error ?? `HTTP ${res.status}` });
      } else {
        setResult({ inserted: body.inserted, duplicates: body.duplicates, filename: file.name });
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
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? "border-emerald-400 bg-emerald-500/10" : "border-border bg-muted/30"
        }`}
      >
        <p className="text-sm font-medium">
          {file ? file.name : "Drop Export.zip here"}
        </p>
        <p className="text-xs text-muted-foreground">
          {file ? readable(file.size) : "or choose the file — a large export takes about 35 seconds to import"}
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
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" asChild>
            <label htmlFor="export-file" className="cursor-pointer">Choose file</label>
          </Button>
          <Button onClick={submit} disabled={!file || busy} className="bg-emerald-600 text-white hover:bg-emerald-500">
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? `Parsing… ${elapsed}s` : "Import"}
          </Button>
        </div>
        {busy ? (
          <div className="h-1 w-full max-w-sm overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-500" />
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="text-sm font-medium text-emerald-300">
            Imported {result.inserted.toLocaleString("en-US")} rows from {result.filename}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.duplicates > 0
              ? `${result.duplicates.toLocaleString("en-US")} rows were already present and were skipped.`
              : "Nothing was duplicated."}
          </p>
          <div className="mt-3 flex gap-2">
            <Button asChild size="sm">
              <Link href="/training">See training</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/uploads">Import another</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
