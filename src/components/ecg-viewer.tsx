"use client";

import { useMemo, useState } from "react";
import { HeartPulse } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { num } from "@/lib/format";
import type { EcgRecordingRow } from "@/db/queries";
import { cn } from "@/lib/utils";

function buildWaveformPath(samples: number[], width: number, height: number): string {
  if (samples.length < 2) return "";
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const span = Math.max(100, max - min);
  const padY = 14;
  const drawH = height - padY * 2;
  const stepX = width / (samples.length - 1);

  return samples
    .map((val, idx) => {
      const x = Math.round(idx * stepX * 10) / 10;
      const y = Math.round((padY + ((max - val) / span) * drawH) * 10) / 10;
      return `${idx === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
}

export function EcgViewer({ recordings }: { recordings: EcgRecordingRow[] }) {
  const [selectedId, setSelectedId] = useState<number>(recordings[0]?.id ?? 0);

  const active = useMemo(
    () => recordings.find((r) => r.id === selectedId) ?? recordings[0] ?? null,
    [recordings, selectedId],
  );

  const svgWidth = 900;
  const svgHeight = 180;
  const path = useMemo(
    () => (active ? buildWaveformPath(active.samples, svgWidth, svgHeight) : ""),
    [active],
  );

  if (!active) return null;

  const durationSec = active.samplingHz > 0 ? active.sampleCount / active.samplingHz : 30;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border p-4" aria-labelledby="ecg-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HeartPulse aria-hidden className="size-4 text-destructive" />
          <h2 id="ecg-heading" className="text-sm font-medium">Electrocardiograms (ECG)</h2>
          <Badge variant="outline">{recordings.length}</Badge>
        </div>
        {recordings.length > 1 ? (
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="ECG recordings">
            {recordings.map((rec) => (
              <button
                key={rec.id}
                type="button"
                role="tab"
                aria-selected={rec.id === active.id}
                onClick={() => setSelectedId(rec.id)}
                className={cn(
                  "min-h-8 rounded-md border px-2.5 text-xs transition-colors",
                  rec.id === active.id
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {rec.day} · {rec.classification}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="secondary">{active.classification}</Badge>
        {active.avgHr !== null ? <Badge variant="outline">~{num(active.avgHr, 0)} bpm</Badge> : null}
        <Badge variant="outline">{num(durationSec, 0)} s · {num(active.samplingHz, 0)} Hz</Badge>
        {active.device ? <Badge variant="outline">{active.device}</Badge> : null}
        <span className="num text-muted-foreground">{active.recordedAt}</span>
        {active.symptoms ? <span className="text-muted-foreground">Symptoms: {active.symptoms}</span> : null}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/60 bg-muted/20 p-2">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="img"
          aria-label={`Lead I ECG waveform recorded ${active.recordedAt}, ${active.classification}`}
          className="h-44 w-full min-w-[640px]"
        >
          <g stroke="var(--destructive)" strokeOpacity="0.14" strokeWidth="1">
            {Array.from({ length: 19 }, (_, i) => (
              <line key={`v-${i}`} x1={i * 50} y1="0" x2={i * 50} y2={svgHeight} />
            ))}
            {Array.from({ length: 7 }, (_, i) => (
              <line key={`h-${i}`} x1="0" y1={i * 30} x2={svgWidth} y2={i * 30} />
            ))}
          </g>
          <path
            d={path}
            fill="none"
            stroke="var(--destructive)"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Lead I ({active.unit}) · {active.sampleCount.toLocaleString("en-US")} samples envelope-downsampled for display. For reference only; not a medical diagnosis.
      </p>
    </section>
  );
}
