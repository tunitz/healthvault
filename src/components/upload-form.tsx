"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        toast.error("Upload failed", { description: body.error ?? `HTTP ${res.status}` });
      } else {
        toast.success(`Imported ${body.inserted} rows`, {
          description:
            body.duplicates > 0
              ? `${body.duplicates} rows were already in the database (skipped).`
              : "No duplicates found.",
        });
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
        router.refresh();
      }
    } catch (e) {
      toast.error("Upload failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        disabled={busy}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="sm:max-w-md"
      />
      <Button onClick={submit} disabled={!file || busy}>
        {busy ? <Spinner data-icon="inline-start" /> : null}
        {busy ? "Parsing export…" : "Upload Export.zip"}
      </Button>
    </div>
  );
}
