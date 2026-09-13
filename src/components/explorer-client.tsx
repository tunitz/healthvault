"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { num, typeLabel } from "@/lib/format";

export type TypeStat = {
  typeIdentifier: string; unit: string; count: number;
  firstDay: string; lastDay: string; sum: number; avg: number; max: number;
};

type Row = { day: string; startDate: string; endDate: string; value: number; unit: string; sourceName: string };

export function ExplorerClient({ types }: { types: TypeStat[] }) {
  const [selected, setSelected] = useState(types[0]?.typeIdentifier ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/type-stats?type=${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((body: { rows: Row[] }) => {
        if (!cancelled) setRows(body.rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const stats = types.find((t) => t.typeIdentifier === selected);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
          <p className="text-sm text-muted-foreground">
            {types.length} record types found in the export
          </p>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardDescription>Records</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{num(stats.count)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Average</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{num(stats.avg, 2)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">unit: {stats.unit || "—"}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Max</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{num(stats.max, 2)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Date range</CardDescription>
              <CardTitle className="text-base tabular-nums">
                {stats.firstDay} → {stats.lastDay}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Latest records</CardTitle>
          <CardDescription>
            Newest 200 rows for {typeLabel(selected)}. Sleep stages are stored as codes: 1 In bed, 2 Asleep,
            3 Awake, 4 Core, 5 Deep, 6 REM.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                  <TableHead>End</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={`${r.startDate}-${i}`}>
                    <TableCell className="tabular-nums">{r.day}</TableCell>
                    <TableCell className="tabular-nums">{r.startDate}</TableCell>
                    <TableCell className="tabular-nums">{r.endDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(r.value, 2)}</TableCell>
                    <TableCell>{r.unit || "—"}</TableCell>
                    <TableCell>{r.sourceName || "—"}</TableCell>
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
