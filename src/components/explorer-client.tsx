"use client";

import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { num, typeLabel } from "@/lib/format";

export type TypeStat = {
  typeIdentifier: string; unit: string; count: number;
  firstDay: string; lastDay: string; sum: number; avg: number; max: number;
};

type Row = { day: string; startDate: string; endDate: string; value: number; unit: string; sourceName: string };

function Metric({ title, value, unit }: { title: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="num text-2xl font-semibold tracking-tight">{value}</p>
      {unit ? <p className="text-xs text-muted-foreground">{unit}</p> : null}
    </div>
  );
}

export function ExplorerClient({ types }: { types: TypeStat[] }) {
  const [selected, setSelected] = useState(types[0]?.typeIdentifier ?? "");
  // Loading is derived: the rows on screen belong to `result.type`, so a different selection
  // is "loading" without a synchronous setState inside the effect.
  const [result, setResult] = useState<{ type: string; rows: Row[] } | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    fetch(`/api/type-stats?type=${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((body: { rows: Row[] }) => {
        if (!cancelled) setResult({ type: selected, rows: body.rows });
      })
      .catch(() => {
        if (!cancelled) setResult({ type: selected, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const loading = Boolean(selected) && result?.type !== selected;
  const rows = result?.rows ?? [];
  const stats = types.find((t) => t.typeIdentifier === selected);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
          <p className="text-sm text-muted-foreground">{types.length} record types found in the export</p>
        </div>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-full sm:w-[360px]">
            <SelectValue placeholder="Pick a record type" />
          </SelectTrigger>
          <SelectContent>
            {types.map((t) => (
              <SelectItem key={t.typeIdentifier} value={t.typeIdentifier}>
                {typeLabel(t.typeIdentifier)} ({num(t.count)})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {stats ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
          <Metric title="Records" value={num(stats.count)} />
          <Metric title="Average" value={num(stats.avg, 2)} unit={`unit: ${stats.unit || "—"}`} />
          <Metric title="Max" value={num(stats.max, 2)} />
          <Metric title="Date range" value={`${stats.firstDay} → ${stats.lastDay}`} />
        </div>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Latest records</h2>
          <p className="text-xs text-muted-foreground">
            Newest 200 rows for {typeLabel(selected)}. Sleep stages are stored as codes: 1 In bed, 2 Asleep,
            3 Awake, 4 Core, 5 Deep, 6 REM.
          </p>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Start</TableHead>
                <TableHead className="hidden sm:table-cell">End</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="hidden md:table-cell">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.startDate}-${i}`}>
                  <TableCell className="num">{r.day}</TableCell>
                  <TableCell className="num">{r.startDate}</TableCell>
                  <TableCell className="num hidden sm:table-cell">{r.endDate}</TableCell>
                  <TableCell className="num text-right">{num(r.value, 2)}</TableCell>
                  <TableCell>{r.unit || "—"}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{r.sourceName || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
