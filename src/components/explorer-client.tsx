"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
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

const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

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

/** Apple writes "2026-11-09 19:39:00 +0800"; the day column already carries the date. */
function clockOf(value: string): string {
  return value.slice(11, 16);
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

export function ExplorerClient({
  types,
  initial,
}: {
  types: TypeStat[];
  initial: { type: string; rows: ExplorerRow[] };
}) {
  const [selected, setSelected] = useState(initial.type);
  const [result, setResult] = useState<{ type: string; rows: ExplorerRow[] }>(initial);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Loading is derived: the rows on screen belong to `result.type`, so a different selection
  // is "loading" without a synchronous setState inside the effect. The first type is already
  // rendered by the server, so its request is skipped. A failed fetch sets `error` instead of
  // silently substituting an empty result, so the failure stays visible until Retry succeeds.
  useEffect(() => {
    if (!selected || result?.type === selected) return;
    let cancelled = false;
    fetch(`/api/type-stats?type=${encodeURIComponent(selected)}`)
      .then((r) => {
        if (!r.ok) {
          if (!cancelled) setError(explorerFetchError(r.status));
          return null;
        }
        return r.json() as Promise<{ rows: ExplorerRow[] }>;
      })
      .then((body) => {
        if (!cancelled && body) {
          setResult({ type: selected, rows: body.rows });
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError(explorerFetchError(null));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, result?.type, attempt]);

  const loading = Boolean(selected) && result?.type !== selected && !error;
  const rows = result?.rows ?? [];
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

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
          <p className="text-sm text-muted-foreground">{types.length} record types</p>
        </div>

        <div
          className="relative w-full sm:w-[380px]"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
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
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search types"
                aria-label="Search record types"
                className="mb-2"
              />
              <ul role="listbox" aria-label="Record types" className="max-h-64 overflow-auto">
                {filtered.map((type) => (
                  <li key={type.typeIdentifier}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={type.typeIdentifier === selected}
                      onClick={() => {
                        setSelected(type.typeIdentifier);
                        setOpen(false);
                        setQuery("");
                        setError(null);
                      }}
                      className={cn(
                        "flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-accent",
                        type.typeIdentifier === selected && "bg-muted font-medium",
                      )}
                    >
                      <span className="truncate">{typeLabel(type.typeIdentifier)}</span>
                      <span className="num shrink-0 text-xs text-muted-foreground">{num(type.count)}</span>
                    </button>
                  </li>
                ))}
                {filtered.length === 0 ? (
                  <li className="px-2 py-3 text-xs text-muted-foreground">No match</li>
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

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Latest records</h2>
          <p className="text-xs text-muted-foreground">
            Newest 200 rows for {typeLabel(selected)}.
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
                <TableHead className="w-16">Start</TableHead>
                <TableHead className="hidden w-16 sm:table-cell">End</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="hidden md:table-cell">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-sm text-muted-foreground">
                    No rows for this type.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, index) => (
                  <TableRow key={`${row.startDate}-${index}`}>
                    <TableCell className="num">{row.day}</TableCell>
                    <TableCell className="num w-16">{clockOf(row.startDate)}</TableCell>
                    <TableCell className="num hidden w-16 sm:table-cell">{clockOf(row.endDate)}</TableCell>
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
