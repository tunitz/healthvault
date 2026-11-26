"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { num, typeLabel } from "@/lib/format";

export type TypeStat = {
  typeIdentifier: string; unit: string; count: number;
  firstDay: string; lastDay: string; sum: number; avg: number; max: number;
};

export type ExplorerRow = { day: string; startDate: string; endDate: string; value: number; unit: string; sourceName: string };
export type ExplorerTrendPoint = { day: string; value: number; source: string };

const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

const SELECT =
  "h-9 max-sm:h-11 min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

function Metric({
  title,
  value,
  unit,
  small = false,
  className,
}: {
  title: string;
  value: string;
  unit?: string;
  small?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1 border-t border-border pt-3", className)}>
      <p className="text-xs text-muted-foreground">{title}</p>
      <p
        className={cn(
          "num font-semibold tracking-tight",
          small ? "text-sm whitespace-nowrap sm:text-base" : "text-2xl",
        )}
      >
        {value}
      </p>
      {unit ? <p className="text-xs text-muted-foreground">{unit}</p> : null}
    </div>
  );
}

/** Apple writes "2026-11-09 19:39:05 +0800"; the day column already carries the date. */
function clockOf(value: string): string {
  return value.slice(11, 19);
}

/** Actionable, human-readable reason a records fetch failed. `null` means a network-level
 * failure with no HTTP status. Kept pure so the error text can be asserted without a browser. */
export function explorerFetchError(status: number | null): string {
  if (status === null) return "Could not reach the server. Check your connection and retry.";
  if (status === 401 || status === 403) return "Your session expired. Sign in again and retry.";
  if (status >= 500) return `The server could not load these records (${status}). Try again shortly.`;
  return `Could not load these records (${status}). Retry.`;
}

/** Visible failure state: a message and a full-height Retry target, never a silent empty table. */
export function ExplorerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-5"
    >
      <p className="text-sm text-destructive">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-11 rounded-md border border-input bg-background px-4 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Retry
      </button>
    </div>
  );
}

type ResultState = {
  key: string;
  type: string;
  rows: ExplorerRow[];
  trend: ExplorerTrendPoint[];
  sources: string[];
};

export function ExplorerClient({
  types,
  initial,
}: {
  types: TypeStat[];
  initial: { type: string; rows: ExplorerRow[]; trend?: ExplorerTrendPoint[]; sources?: string[] };
}) {
  const [selected, setSelected] = useState(initial.type);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [source, setSource] = useState("");

  const requestKey = `${selected}|${fromDay}|${toDay}|${source}`;
  const [result, setResult] = useState<ResultState>({
    key: `${initial.type}|||`,
    type: initial.type,
    rows: initial.rows,
    trend: initial.trend ?? [],
    sources: initial.sources ?? [],
  });

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!dropdownRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!selected || result.key === requestKey) return;
    let cancelled = false;
    const sp = new URLSearchParams({ type: selected });
    if (fromDay) sp.set("from", fromDay);
    if (toDay) sp.set("to", toDay);
    if (source) sp.set("source", source);
    fetch(`/api/type-stats?${sp.toString()}`)
      .then((r) => {
        if (!r.ok) {
          if (!cancelled) setError(explorerFetchError(r.status));
          return null;
        }
        return r.json() as Promise<{
          rows: ExplorerRow[];
          trend?: ExplorerTrendPoint[];
          sources?: string[];
        }>;
      })
      .then((body) => {
        if (!cancelled && body) {
          setResult({
            key: requestKey,
            type: selected,
            rows: body.rows,
            trend: body.trend ?? [],
            sources: body.sources ?? [],
          });
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError(explorerFetchError(null));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, fromDay, toDay, source, requestKey, result.key, attempt]);

  const loading = Boolean(selected) && result.key !== requestKey && !error;
  const rows = result.rows;
  const trend = result.trend;
  const sources = result.sources;
  const stats = types.find((t) => t.typeIdentifier === selected);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return types;
    return types.filter(
      (t) =>
        typeLabel(t.typeIdentifier).toLowerCase().includes(needle) ||
        t.typeIdentifier.toLowerCase().includes(needle),
    );
  }, [types, query]);

  const selectedLabel = stats
    ? `${typeLabel(stats.typeIdentifier)} (${num(stats.count)})`
    : "Pick a record type";

  const exportQuery = useMemo(() => {
    const sp = new URLSearchParams({ type: selected });
    if (fromDay) sp.set("from", fromDay);
    if (toDay) sp.set("to", toDay);
    if (source) sp.set("source", source);
    return sp.toString();
  }, [selected, fromDay, toDay, source]);

  function selectType(nextType: string) {
    setSelected(nextType);
    setSource("");
    setOpen(false);
    setQuery("");
    setError(null);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
          <p className="text-sm text-muted-foreground">{types.length} record types</p>
        </div>

        <div
          ref={dropdownRef}
          className="relative w-full sm:w-[380px]"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (!open || filtered.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((prev) => (prev + 1) % filtered.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(filtered.length - 1);
            } else if (event.key === "Enter") {
              const chosen = filtered[Math.min(activeIndex, filtered.length - 1)];
              if (chosen) {
                event.preventDefault();
                selectType(chosen.typeIdentifier);
              }
            }
          }}
        >
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => {
              setOpen((value) => {
                if (!value) setActiveIndex(Math.max(0, filtered.findIndex((t) => t.typeIdentifier === selected)));
                return !value;
              });
            }}
            className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:h-11 dark:bg-input/30"
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>

          {open ? (
            <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg">
              <Input
                autoFocus
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                placeholder="Search types"
                aria-label="Search record types"
                aria-activedescendant={
                  filtered[Math.min(activeIndex, Math.max(0, filtered.length - 1))]
                    ? `explorer-opt-${filtered[Math.min(activeIndex, filtered.length - 1)].typeIdentifier}`
                    : undefined
                }
                className="mb-2"
              />
              <ul role="listbox" aria-label="Record types" className="max-h-64 overflow-auto">
                {filtered.map((type, idx) => {
                  const isCurrent = idx === Math.min(activeIndex, filtered.length - 1);
                  return (
                    <li key={type.typeIdentifier} role="presentation">
                      <button
                        id={`explorer-opt-${type.typeIdentifier}`}
                        type="button"
                        role="option"
                        aria-selected={type.typeIdentifier === selected}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => selectType(type.typeIdentifier)}
                        className={cn(
                          "flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-accent",
                          type.typeIdentifier === selected && "bg-muted font-medium",
                          isCurrent && "ring-2 ring-ring/60",
                        )}
                      >
                        <span className="truncate">{typeLabel(type.typeIdentifier)}</span>
                        <span className="num shrink-0 text-xs text-muted-foreground">{num(type.count)}</span>
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 ? (
                  <li role="presentation" className="px-2 py-3 text-xs text-muted-foreground">No match</li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      {stats ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
          <Metric title="Records" value={num(stats.count)} />
          <Metric title="Average" value={num(stats.avg, 1)} unit={`unit: ${stats.unit || "—"}`} />
          <Metric title="Max" value={num(stats.max, 1)} />
          <Metric
            title="Date range"
            value={`${stats.firstDay} → ${stats.lastDay}`}
            small
            className="col-span-2 lg:col-span-1"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>From</span>
          <Input
            type="date"
            value={fromDay}
            onChange={(e) => setFromDay(e.target.value)}
            className="h-9 w-36 max-sm:h-11"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>To</span>
          <Input
            type="date"
            value={toDay}
            onChange={(e) => setToDay(e.target.value)}
            className="h-9 w-36 max-sm:h-11"
          />
        </label>
        {sources.length > 0 ? (
          <label className="flex min-w-40 flex-col gap-1 text-xs text-muted-foreground">
            <span>Source</span>
            <select value={source} onChange={(e) => setSource(e.target.value)} className={SELECT}>
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {(fromDay || toDay || source) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setFromDay("");
              setToDay("");
              setSource("");
            }}
          >
            Clear
          </Button>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 sm:ms-auto">
          <Button asChild variant="outline" size="sm">
            <a href={`/api/type-stats?${exportQuery}&format=csv`} download>
              <Download aria-hidden className="size-3.5" />
              CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={`/api/type-stats?${exportQuery}&format=json`} download>
              <Download aria-hidden className="size-3.5" />
              JSON
            </a>
          </Button>
        </div>
      </div>

      {trend.length > 1 ? (
        <section className="flex flex-col gap-2 rounded-xl border border-border p-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-medium">Daily trend · {typeLabel(selected)}</h2>
            <p className="text-xs text-muted-foreground">
              Single-source per day ({trend.length} days{stats?.unit ? ` · ${stats.unit}` : ""}).
            </p>
          </div>
          <SeriesChart
            data={trend.map((p) => ({ day: p.day, value: p.value }))}
            kind="area"
            label={typeLabel(selected)}
            unit={stats?.unit || undefined}
            ariaLabel={`Daily trend for ${typeLabel(selected)}`}
          />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Latest records</h2>
          <p className="text-xs text-muted-foreground">
            Newest {rows.length} rows for {typeLabel(selected)}.
            {selected === SLEEP_TYPE
              ? " Sleep stages are codes: 1 In bed, 2 Asleep, 3 Awake, 4 Core, 5 Deep, 6 REM."
              : ""}
          </p>
        </div>
        {error ? (
          <ExplorerError
            message={error}
            onRetry={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          />
        ) : loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="w-20">Start</TableHead>
                <TableHead className="hidden w-20 sm:table-cell">End</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="hidden md:table-cell">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-sm text-muted-foreground">
                    No rows for this filter.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, index) => (
                  <TableRow key={`${row.startDate}-${index}`}>
                    <TableCell className="num">{row.day}</TableCell>
                    <TableCell className="num w-20">{clockOf(row.startDate)}</TableCell>
                    <TableCell className="num hidden w-20 sm:table-cell">{clockOf(row.endDate)}</TableCell>
                    <TableCell className="num text-right">{num(row.value, 2)}</TableCell>
                    <TableCell>{row.unit || "—"}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {row.sourceName || "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
