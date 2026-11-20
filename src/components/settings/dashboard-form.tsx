"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONFLICT_MESSAGE,
  ConflictError,
  errorMessage,
  fetchSettings,
  resetSection,
  saveSettings,
} from "@/components/dashboard/settings-api";
import { defaultAppSettings } from "@/components/dashboard/defaults";
import {
  DISPLAY_LABELS,
  isWidgetId,
  orderedVisibleWidgets,
  RANGES,
  RANGE_LABELS,
  SIZES,
  SIZE_LABELS,
  WIDGET_IDS,
  WIDGET_META,
  allowedDisplay,
} from "@/components/dashboard/registry";
import type { AppSettings, DashboardSettings, SettingsSnapshot, WidgetPreference } from "@/lib/services/settings";

const SIZE_OPTIONS = SIZES.map((size) => ({ value: size, label: SIZE_LABELS[size] }));
const RANGE_OPTIONS = RANGES.map((range) => ({ value: range, label: RANGE_LABELS[range] }));

function cloneWidgets(widgets: Record<string, WidgetPreference>): Record<string, WidgetPreference> {
  return Object.fromEntries(Object.entries(widgets).map(([key, value]) => [key, { ...value }]));
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** Labelled, full-width shadcn Select (h-11 trigger on mobile) with no native spinner. */
function WidgetSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
  id: string;
}) {
  const labelId = `${id}-label`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={labelId} className="text-xs text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
        <SelectTrigger id={id} className="w-full" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Settings → Dashboard. Every change previews in the list; nothing is saved until Save. */
export function DashboardForm({ initialSnapshot }: { initialSnapshot?: SettingsSnapshot } = {}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(initialSnapshot ?? null);
  const [draft, setDraft] = useState<DashboardSettings | null>(
    initialSnapshot ? cloneDashboard(initialSnapshot.value.dashboard) : null,
  );
  const [revision, setRevision] = useState(initialSnapshot?.revision ?? 0);
  const [layoutName, setLayoutName] = useState("");
  const [loading, setLoading] = useState(!initialSnapshot);
  const [pending, setPending] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [layoutToDelete, setLayoutToDelete] = useState<{ key: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (initialSnapshot) return;
    let active = true;
    fetchSettings()
      .then((loaded) => {
        if (!active) return;
        setSnapshot(loaded);
        setDraft(cloneDashboard(loaded.value.dashboard));
        setRevision(loaded.revision);
      })
      .catch((cause) => active && setError(errorMessage(cause)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [initialSnapshot]);

  const patchWidget = useCallback((id: string, patch: Partial<WidgetPreference>) => {
    setDraft((current) => {
      if (!current || !isWidgetId(id)) return current;
      return {
        ...current,
        widgets: { ...current.widgets, [id]: { ...current.widgets[id], ...patch } },
      };
    });
    setError(null);
    setConflict(false);
  }, []);

  /** Tap/keyboard alternative to drag-and-drop: swap this card's order with its neighbour. */
  const move = useCallback((id: string, delta: -1 | 1) => {
    setDraft((current) => {
      if (!current || !isWidgetId(id)) return current;
      const widgets = cloneWidgets(current.widgets);
      const list = [...WIDGET_IDS].sort(
        (a, b) => widgets[a].order - widgets[b].order || WIDGET_IDS.indexOf(a) - WIDGET_IDS.indexOf(b),
      );
      const from = list.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= list.length) return current;
      const a = widgets[list[from]];
      const b = widgets[list[to]];
      const order = a.order;
      widgets[list[from]] = { ...a, order: b.order };
      widgets[list[to]] = { ...b, order };
      return { ...current, widgets };
    });
    setError(null);
    setConflict(false);
  }, []);

  const saveLayout = useCallback(() => {
    const key = slug(layoutName);
    if (!key) {
      setError("Enter a layout name first");
      return;
    }
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        namedLayouts: { ...current.namedLayouts, [key]: { name: layoutName.trim().slice(0, 40), widgets: cloneWidgets(current.widgets) } },
        activeLayout: key,
      };
    });
    setLayoutName("");
    setError(null);
  }, [layoutName]);

  const applyLayout = useCallback((key: string) => {
    setDraft((current) => {
      const layout = current?.namedLayouts[key];
      if (!current || !layout) return current;
      return { ...current, widgets: cloneWidgets(layout.widgets), activeLayout: key };
    });
    setError(null);
  }, []);

  const setActiveLayout = useCallback((key: string) => {
    setDraft((current) => (current && current.namedLayouts[key] ? { ...current, activeLayout: key } : current));
    setError(null);
  }, []);

  const deleteLayout = useCallback((key: string) => {
    setDraft((current) => {
      if (!current) return current;
      const namedLayouts = { ...current.namedLayouts };
      delete namedLayouts[key];
      return { ...current, namedLayouts, activeLayout: current.activeLayout === key ? null : current.activeLayout };
    });
  }, []);

  async function onSave() {
    if (!snapshot || !draft) return;
    setPending(true);
    setError(null);
    setConflict(false);
    try {
      const value: AppSettings = { ...snapshot.value, dashboard: draft };
      const saved = await saveSettings(value, revision);
      setSnapshot(saved);
      setRevision(saved.revision);
      setDraft(cloneDashboard(saved.value.dashboard));
      toast.success("Dashboard layout saved");
    } catch (cause) {
      if (cause instanceof ConflictError) setConflict(true);
      setError(errorMessage(cause));
      toast.error("Dashboard layout not saved");
    } finally {
      setPending(false);
    }
  }

  async function onRestore() {
    if (!snapshot) return;
    setPending(true);
    setError(null);
    setConflict(false);
    try {
      const saved = await resetSection(snapshot.value, revision, "dashboard", defaultAppSettings());
      setSnapshot(saved);
      setRevision(saved.revision);
      setDraft(cloneDashboard(saved.value.dashboard));
      toast.success("Dashboard restored to defaults");
    } catch (cause) {
      if (cause instanceof ConflictError) setConflict(true);
      setError(errorMessage(cause));
      toast.error("Dashboard not restored");
    } finally {
      setPending(false);
    }
  }

  if (loading || !draft || !snapshot) {
    return <p className="text-sm text-muted-foreground">Loading dashboard preferences…</p>;
  }

  const preview = orderedVisibleWidgets(draft.widgets);
  const sortedIds = [...WIDGET_IDS].sort(
    (a, b) => draft.widgets[a].order - draft.widgets[b].order || WIDGET_IDS.indexOf(a) - WIDGET_IDS.indexOf(b),
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Cards</h3>
          <p className="text-xs text-muted-foreground">
            Use Show, Move up and Move down instead of dragging. Order is the same on every device.
          </p>
        </div>
        <ul className="divide-y divide-border rounded-lg border">
          {sortedIds.map((id) => {
            const pref = draft.widgets[id];
            const meta = WIDGET_META[id];
            const position = sortedIds.indexOf(id) + 1;
            return (
              <li key={id} className="space-y-3 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={pref.visible}
                      disabled={pending}
                      onChange={(event) => patchWidget(id, { visible: event.target.checked })}
                      className="size-4 accent-[var(--primary)]"
                      aria-label={`Show ${meta.title} on the dashboard`}
                    />
                    {meta.title}
                  </label>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending || position === 1}
                      onClick={() => move(id, -1)}
                      aria-label={`Move ${meta.title} up`}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending || position === sortedIds.length}
                      onClick={() => move(id, 1)}
                      aria-label={`Move ${meta.title} down`}
                    >
                      ↓
                    </Button>
                    <label className="sr-only" htmlFor={`order-${id}`}>Order for {meta.title}</label>
                    <Input
                      id={`order-${id}`}
                      type="number"
                      min={0}
                      max={1000}
                      value={pref.order}
                      disabled={pending}
                      onChange={(event) => patchWidget(id, { order: Number(event.target.value) })}
                      className="w-16 text-center"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{meta.description}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <WidgetSelect
                    id={`size-${id}`}
                    label="Size"
                    value={pref.size}
                    options={SIZE_OPTIONS}
                    onChange={(size) => patchWidget(id, { size })}
                    disabled={pending}
                  />
                  <WidgetSelect
                    id={`range-${id}`}
                    label="Date range"
                    value={pref.range}
                    options={RANGE_OPTIONS}
                    onChange={(range) => patchWidget(id, { range })}
                    disabled={pending}
                  />
                  <WidgetSelect
                    id={`display-${id}`}
                    label="View"
                    value={allowedDisplay(id, pref.display)}
                    options={meta.displays.map((display) => ({ value: display, label: DISPLAY_LABELS[display] }))}
                    onChange={(display) => patchWidget(id, { display })}
                    disabled={pending}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Preview order</h3>
        <p className="text-xs text-muted-foreground">
          {preview.length === 0
            ? "No cards visible."
            : preview.map(({ id }) => WIDGET_META[id].title).join(" → ")}
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Saved layouts</h3>
        <p className="text-xs text-muted-foreground">
          Save a named arrangement, then switch between layouts without reconfiguring every card.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Layout name
            <Input
              value={layoutName}
              disabled={pending}
              maxLength={40}
              onChange={(event) => setLayoutName(event.target.value)}
              placeholder="e.g. Training week"
            />
          </label>
          <Button type="button" variant="outline" onClick={saveLayout} disabled={pending || !slug(layoutName)}>
            Save current layout
          </Button>
        </div>
        <ul className="divide-y divide-border rounded-lg border">
          {Object.entries(draft.namedLayouts).map(([key, layout]) => (
            <li key={key} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="active-layout"
                  checked={draft.activeLayout === key}
                  disabled={pending}
                  onChange={() => setActiveLayout(key)}
                  className="size-4 accent-[var(--primary)]"
                />
                <span>{layout.name}</span>
              </label>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => applyLayout(key)} disabled={pending}>
                  Apply
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setLayoutToDelete({ key, name: layout.name })}
                  disabled={pending}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
          {Object.keys(draft.namedLayouts).length === 0 ? (
            <li className="p-3 text-xs text-muted-foreground">No saved layouts yet.</li>
          ) : null}
        </ul>
      </section>

      {error ? (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <p>{error}</p>
          {conflict ? (
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
              Reload settings
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button type="button" onClick={onSave} disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Save dashboard"}
        </Button>
        <Button type="button" variant="outline" onClick={() => setConfirmRestore(true)} disabled={pending}>
          Restore defaults
        </Button>
        {conflict ? (
          <span className="text-xs font-medium text-destructive">{CONFLICT_MESSAGE}</span>
        ) : (
          <span className="text-xs text-muted-foreground">Saved across devices when you press Save.</span>
        )}
      </div>

      <ConfirmDialog
        open={confirmRestore}
        onOpenChange={setConfirmRestore}
        title="Restore dashboard defaults?"
        description="This resets all widget visibility, sizes, ranges, display modes, and removes saved layouts."
        confirmLabel="Restore defaults"
        onConfirm={() => {
          setConfirmRestore(false);
          void onRestore();
        }}
      />
      <ConfirmDialog
        open={layoutToDelete !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setLayoutToDelete(null);
        }}
        title={layoutToDelete ? `Delete layout "${layoutToDelete.name}"?` : "Delete layout?"}
        description="This removes the saved layout from your draft. Save dashboard to persist the removal."
        confirmLabel="Delete layout"
        onConfirm={() => {
          if (layoutToDelete) deleteLayout(layoutToDelete.key);
          setLayoutToDelete(null);
        }}
      />
    </div>
  );
}

function cloneDashboard(value: DashboardSettings): DashboardSettings {
  return {
    widgets: cloneWidgets(value.widgets),
    namedLayouts: Object.fromEntries(
      Object.entries(value.namedLayouts).map(([key, layout]) => [key, { name: layout.name, widgets: cloneWidgets(layout.widgets) }]),
    ),
    activeLayout: value.activeLayout,
  };
}
