import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ExplorerClient } from "@/components/explorer-client";
import { EcgViewer } from "@/components/ecg-viewer";
import {
  explorerDailyTrend,
  explorerSources,
  listEcgRecordings,
  recordsForType,
  typeStats,
} from "@/db/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Explorer" };

function ExplorerSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading explorer">
      <div className="h-8 w-32 rounded-md bg-muted" />
      <div className="h-10 w-full max-w-md rounded-md bg-muted/60" />
      <div className="h-64 w-full rounded-xl border border-border bg-muted/30" />
    </div>
  );
}

function ExplorerContent() {
  const types = typeStats();
  const ecgs = listEcgRecordings();
  if (types.length === 0 && ecgs.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
        <p className="text-sm text-muted-foreground">
          No records yet. <Link className="text-primary underline underline-offset-4" href="/uploads">Import an export</Link> to browse record types.
        </p>
      </div>
    );
  }
  const first = types[0];
  return (
    <div className="flex flex-col gap-10">
      {first ? (
        <ExplorerClient
          types={types}
          initial={{
            type: first.typeIdentifier,
            rows: recordsForType(first.typeIdentifier),
            trend: explorerDailyTrend(first.typeIdentifier),
            sources: explorerSources(first.typeIdentifier),
          }}
        />
      ) : null}
      {ecgs.length > 0 ? <EcgViewer recordings={ecgs} /> : null}
    </div>
  );
}

export default function ExplorerPage() {
  return (
    <Suspense fallback={<ExplorerSkeleton />}>
      <ExplorerContent />
    </Suspense>
  );
}
