"use client";

/**
 * The dashboard widget header's compact meta text ("30 days · Summary · 1/9") as a single
 * clickable control. This is the only client boundary on the otherwise server-rendered
 * dashboard. Every change goes through the versioned settings API so a stale write from
 * another device is rejected rather than silently overwritten.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  allowedDisplay,
  DISPLAY_LABELS,
  orderedVisibleWidgets,
  RANGES,
  RANGE_LABELS,
  SIZES,
  SIZE_LABELS,
  WIDGET_META,
} from "./registry";
import type { WidgetId } from "./registry";
import type {
  AppSettings,
  WidgetDisplay,
  WidgetPreference,
  WidgetRange,
  WidgetSize,
} from "@/lib/services/settings";
import { ConflictError, errorMessage, fetchSettings, saveSettings } from "./settings-api";

const CONFLICT_TEXT = "Settings changed elsewhere — reload";

const itemClass = cn(
  "flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm",
  "text-foreground transition-colors hover:bg-accent",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
);
const headingClass = "px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

export type WidgetMenuProps = {
  id: WidgetId;
  index: number;
  total: number;
  range: WidgetRange;
  display: WidgetDisplay;
  size?: WidgetSize;
};

export function WidgetMenu({ id, index, total, range, display, size }: WidgetMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const title = WIDGET_META[id].title;
  const label = `${RANGE_LABELS[range]} · ${DISPLAY_LABELS[display]} · ${index + 1}/${total}`;
  const currentDisplay = allowedDisplay(id, display);

  // Escape closes and returns focus to the trigger; arrows/Home/End navigate menu items; outside click closes.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      const menu = menuRef.current;
      if (!menu) return;
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')];
      if (items.length === 0) return;
      const activeIdx = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        items[(activeIdx + 1) % items.length].focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[(activeIdx - 1 + items.length) % items.length].focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0].focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1].focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // On open, focus the selected option (or the first control) for keyboard users.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const selected = menu.querySelector<HTMLElement>('[aria-checked="true"]');
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]');
    (selected ?? first)?.focus();
  }, [open]);

  /**
   * GET a snapshot, change only the affected widget preference(s), PUT with the same revision.
   * A 409 surfaces inline and never retries with a refreshed value (no silent overwrite).
   */
  const persist = useCallback(
    async (update: (widgets: Record<string, WidgetPreference>) => boolean) => {
      if (busy) return;
      setBusy(true);
      setConflict(false);
      setError(null);
      try {
        const snapshot = await fetchSettings();
        const widgets: Record<string, WidgetPreference> = { ...snapshot.value.dashboard.widgets };
        if (!update(widgets)) return;
        const value: AppSettings = {
          ...snapshot.value,
          dashboard: { ...snapshot.value.dashboard, widgets },
        };
        await saveSettings(value, snapshot.revision);
        setOpen(false);
        router.refresh();
      } catch (cause) {
        if (cause instanceof ConflictError) {
          setConflict(true);
          toast.error(CONFLICT_TEXT);
        } else {
          setError(errorMessage(cause));
          toast.error("Could not save widget settings");
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, router],
  );

  const chooseRange = (next: WidgetRange) =>
    persist((widgets) => {
      if (!widgets[id] || widgets[id].range === next) return false;
      widgets[id] = { ...widgets[id], range: next };
      return true;
    });

  const chooseDisplay = (next: WidgetDisplay) =>
    persist((widgets) => {
      if (!widgets[id] || widgets[id].display === next) return false;
      widgets[id] = { ...widgets[id], display: next };
      return true;
    });

  const chooseSize = (next: WidgetSize) =>
    persist((widgets) => {
      if (!widgets[id] || widgets[id].size === next) return false;
      widgets[id] = { ...widgets[id], size: next };
      return true;
    });

  const hideWidget = () =>
    persist((widgets) => {
      if (!widgets[id] || !widgets[id].visible) return false;
      widgets[id] = { ...widgets[id], visible: false };
      return true;
    });

  /** Swap this widget's order with the adjacent *visible* widget from the live snapshot. */
  const move = (delta: -1 | 1) =>
    persist((widgets) => {
      const ordered = orderedVisibleWidgets(widgets);
      const position = ordered.findIndex((entry) => entry.id === id);
      if (position < 0) return false;
      const neighbour = ordered[position + delta];
      if (!neighbour) return false;
      const current = { ...widgets[id] };
      const other = { ...widgets[neighbour.id] };
      const order = current.order;
      current.order = other.order;
      other.order = order;
      widgets[id] = current;
      widgets[neighbour.id] = other;
      return true;
    });

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-0 sm:py-1"
      >
        <span>{label}</span>
        <ChevronDown aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${title} options`}
          className="absolute right-0 top-full z-30 mt-1 max-h-[70vh] w-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <p className={headingClass}>Date range</p>
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === range}
              aria-label={RANGE_LABELS[option]}
              disabled={busy}
              onClick={() => chooseRange(option)}
              className={itemClass}
            >
              <span>{RANGE_LABELS[option]}</span>
              {option === range ? <Check aria-hidden className="size-3.5 text-primary" /> : null}
            </button>
          ))}

          <div className="my-1 border-t border-border" />
          <p className={headingClass}>View</p>
          {WIDGET_META[id].displays.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === currentDisplay}
              aria-label={DISPLAY_LABELS[option]}
              disabled={busy}
              onClick={() => chooseDisplay(option)}
              className={itemClass}
            >
              <span>{DISPLAY_LABELS[option]}</span>
              {option === currentDisplay ? <Check aria-hidden className="size-3.5 text-primary" /> : null}
            </button>
          ))}

          {size ? (
            <>
              <div className="my-1 border-t border-border" />
              <p className={headingClass}>Size</p>
              {SIZES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option === size}
                  aria-label={SIZE_LABELS[option]}
                  disabled={busy}
                  onClick={() => chooseSize(option)}
                  className={itemClass}
                >
                  <span>{SIZE_LABELS[option]}</span>
                  {option === size ? <Check aria-hidden className="size-3.5 text-primary" /> : null}
                </button>
              ))}
            </>
          ) : null}

          <div className="my-1 border-t border-border" />
          <p className={headingClass}>Position</p>
          <button
            type="button"
            role="menuitem"
            aria-label="Move up"
            disabled={busy || index === 0}
            onClick={() => move(-1)}
            className={itemClass}
          >
            <span>Move up</span>
            <ArrowUp aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Move down"
            disabled={busy || index === total - 1}
            onClick={() => move(1)}
            className={itemClass}
          >
            <span>Move down</span>
            <ArrowDown aria-hidden className="size-3.5" />
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            aria-label={`Hide ${title} widget`}
            disabled={busy}
            onClick={hideWidget}
            className={cn(itemClass, "text-muted-foreground hover:text-destructive")}
          >
            <span>Hide card</span>
          </button>

          {error || conflict ? (
            <div role="alert" className="mt-1 border-t border-border px-2 py-2 text-xs text-destructive">
              <p>{conflict ? CONFLICT_TEXT : error}</p>
              {conflict ? (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-1 min-h-11 rounded-md px-1 font-medium underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Reload
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
