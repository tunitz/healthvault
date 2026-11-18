"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ThemeModePicker } from "@/components/theme-toggle";
import {
  applyAppearance,
  cacheAppearance,
  contrastWarning,
  CUSTOM_PRESET,
  effectiveColors,
  PRESETS,
  presetById,
  resolveMode,
} from "@/components/theme-provider";
import {
  CONFLICT_MESSAGE,
  ConflictError,
  errorMessage,
  fetchSettings,
  resetSection,
  saveSettings,
} from "@/components/dashboard/settings-api";
import { defaultAppSettings } from "@/components/dashboard/defaults";
import { cn } from "@/lib/utils";
import type {
  AppSettings,
  AppearanceSettings,
  CustomColors,
  SettingsSnapshot,
} from "@/lib/services/settings";

const COLOR_FIELDS: { key: keyof CustomColors; label: string; fallback: string }[] = [
  { key: "accent", label: "Accent", fallback: "#0f9b83" },
  { key: "background", label: "Background", fallback: "#f7f8fa" },
  { key: "foreground", label: "Text", fallback: "#20242c" },
  { key: "muted", label: "Muted", fallback: "#f1f2f4" },
  { key: "border", label: "Border", fallback: "#d8dbe0" },
];

const ACCENT_SWATCHES = ["#0f9b83", "#2563eb", "#7c3aed", "#c2410c", "#e11d48", "#475569"];

type BackgroundSwatch = { hex: string; label: string };
/** Varied light neutrals, tinted lights and dark tones, grouped for the active mode. */
const BACKGROUND_SWATCHES: Record<"light" | "dark", readonly BackgroundSwatch[]> = {
  light: [
    { hex: "#ffffff", label: "White" },
    { hex: "#f7f8fa", label: "Cloud" },
    { hex: "#f1f3f6", label: "Mist" },
    { hex: "#f6f8ff", label: "Ice blue" },
    { hex: "#f7faf5", label: "Sage" },
    { hex: "#fff8f4", label: "Warm sand" },
  ],
  dark: [
    { hex: "#1c1f24", label: "Charcoal" },
    { hex: "#0f1626", label: "Navy" },
    { hex: "#101a12", label: "Pine" },
    { hex: "#1f1410", label: "Espresso" },
    { hex: "#14181f", label: "Slate" },
    { hex: "#181426", label: "Plum" },
  ],
};

const CHART_PALETTES = [
  { value: "default", label: "Default" },
  { value: "vibrant", label: "Vibrant" },
  { value: "pastel", label: "Pastel" },
  { value: "monochrome", label: "Monochrome" },
] as const;

const DENSITIES = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
] as const;

const CORNERS = [
  { value: "rounded", label: "Rounded" },
  { value: "soft", label: "Soft" },
  { value: "square", label: "Square" },
] as const;

function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm",
              value === option.value
                ? "border-primary bg-primary/10 font-medium"
                : "border-border hover:bg-accent",
            )}
          >
            <input
              type="radio"
              name={`appearance-${label}`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="size-4 accent-[var(--primary)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Settings → Appearance. Every control previews immediately; nothing is persisted until Save. */
export function AppearanceForm() {
  const { setTheme } = useTheme();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<AppearanceSettings | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const savedRef = useRef<AppearanceSettings | null>(null);

  useEffect(() => {
    let active = true;
    fetchSettings()
      .then((loaded) => {
        if (!active) return;
        setSnapshot(loaded);
        setDraft(loaded.value.appearance);
        setRevision(loaded.revision);
        savedRef.current = loaded.value.appearance;
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Live preview: reflects the draft in this document without writing to the server.
  // applyAppearance runs on every draft edit; next-themes is switched only when the mode itself
  // changes, by keying this effect on draft.mode rather than re-asserting it on every colour edit.
  useEffect(() => {
    if (!draft || loading) return;
    applyAppearance(draft);
  }, [draft, loading]);

  const mode = draft?.mode;
  useEffect(() => {
    if (!mode || loading) return;
    setTheme(mode);
  }, [mode, loading, setTheme]);

  // Leaving the page discards an unsaved preview and returns to the persisted appearance.
  useEffect(() => {
    return () => {
      const saved = savedRef.current;
      if (saved) {
        applyAppearance(saved);
        setTheme(saved.mode);
      }
    };
  }, [setTheme]);

  const update = useCallback((patch: Partial<AppearanceSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setError(null);
    setConflict(false);
  }, []);

  /**
   * Merge one colour into the relevant mode's custom overrides — never replace the whole object.
   * The preset is intentionally left selected: its other tokens stay in effect underneath, so a
   * swatch edit cannot blank the preset's look. An explicit targetMode is used when a swatch from
   * the other mode's palette is chosen (that mode is also previewed).
   */
  const setColor = useCallback(
    (key: keyof CustomColors, value: string, targetMode?: "light" | "dark") => {
      setDraft((current) => {
        if (!current) return current;
        const mode = targetMode ?? resolveMode(current.mode);
        const field = mode === "dark" ? "customColorsDark" : "customColors";
        const switchMode = targetMode && resolveMode(current.mode) !== targetMode ? { mode: targetMode } : {};
        return {
          ...current,
          ...switchMode,
          [field]: { ...(current[field] ?? {}), [key]: value },
        };
      });
      setError(null);
      setConflict(false);
    },
    [],
  );

  const selectPreset = useCallback((id: string) => {
    const preset = presetById(id);
    setDraft((current) => {
      if (!current) return current;
      const custom = id === CUSTOM_PRESET ? {} : { customColors: null, customColorsDark: null };
      return {
        ...current,
        preset: id,
        ...custom,
        chartPalette: preset?.chartPalette ?? current.chartPalette,
      };
    });
    setError(null);
    setConflict(false);
  }, []);

  async function onSave() {
    if (!snapshot || !draft) return;
    setPending(true);
    setError(null);
    setConflict(false);
    try {
      const value: AppSettings = { ...snapshot.value, appearance: draft };
      const saved = await saveSettings(value, revision);
      setSnapshot(saved);
      setRevision(saved.revision);
      setDraft(saved.value.appearance);
      savedRef.current = saved.value.appearance;
      cacheAppearance(saved.value.appearance);
      toast.success("Appearance saved");
    } catch (cause) {
      if (cause instanceof ConflictError) setConflict(true);
      setError(errorMessage(cause));
      toast.error("Appearance not saved");
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
      const defaults = defaultAppSettings();
      const saved = await resetSection(snapshot.value, revision, "appearance", defaults);
      setSnapshot(saved);
      setRevision(saved.revision);
      setDraft(saved.value.appearance);
      savedRef.current = saved.value.appearance;
      cacheAppearance(saved.value.appearance);
      toast.success("Appearance restored to defaults");
    } catch (cause) {
      if (cause instanceof ConflictError) setConflict(true);
      setError(errorMessage(cause));
      toast.error("Appearance not restored");
    } finally {
      setPending(false);
    }
  }

  if (loading || !draft || !snapshot) {
    return <p className="text-sm text-muted-foreground">Loading appearance preferences…</p>;
  }

  const resolvedMode = resolveMode(draft.mode);
  const colors = effectiveColors(draft, resolvedMode);
  const warning = contrastWarning(draft, resolvedMode);
  // Only an explicit "Custom" click highlights Custom; editing a swatch keeps its preset visible.
  const activePreset = draft.preset;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Mode</h3>
        <p className="text-xs text-muted-foreground">
          System follows this device. The choice is saved with the rest of your preferences.
        </p>
        <ThemeModePicker value={draft.mode} onChange={(mode) => update({ mode })} disabled={pending} />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Theme preset</h3>
        <div role="radiogroup" aria-label="Theme preset" className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant={activePreset === preset.id ? "default" : "outline"}
              size="sm"
              disabled={pending}
              aria-pressed={activePreset === preset.id}
              onClick={() => selectPreset(preset.id)}
            >
              {preset.label}
            </Button>
          ))}
          <Button
            type="button"
            variant={activePreset === CUSTOM_PRESET ? "default" : "outline"}
            size="sm"
            disabled={pending}
            aria-pressed={activePreset === CUSTOM_PRESET}
            onClick={() => selectPreset(CUSTOM_PRESET)}
          >
            Custom
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Accent palette</h3>
        <div className="flex flex-wrap gap-2">
          {ACCENT_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              disabled={pending}
              onClick={() => setColor("accent", hex)}
              aria-label={`Use accent colour ${hex}`}
              aria-pressed={(colors.accent ?? "").toLowerCase() === hex}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border-2 border-border p-1 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="size-7 rounded-md" style={{ backgroundColor: hex }} aria-hidden />
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Background palette</h3>
          <p className="text-xs text-muted-foreground">Picking a swatch previews it in that mode.</p>
        </div>
        {(["light", "dark"] as const).map((groupMode) => (
          <div key={groupMode} role="group" aria-label={`${groupMode === "light" ? "Light" : "Dark"} backgrounds`} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {groupMode === "light" ? "Light" : "Dark"} backgrounds
              </span>
              {groupMode === resolvedMode ? (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[0.7rem] text-foreground">Active mode</span>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => update({ mode: groupMode })}
                  className="text-xs text-muted-foreground underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Switch to {groupMode} mode
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {BACKGROUND_SWATCHES[groupMode].map(({ hex, label }) => (
                <button
                  key={hex}
                  type="button"
                  disabled={pending}
                  onClick={() => setColor("background", hex, groupMode)}
                  aria-label={`Use ${groupMode} background ${label} ${hex}`}
                  aria-pressed={(effectiveColors(draft, groupMode).background ?? "").toLowerCase() === hex}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border-2 border-border p-1 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="size-7 rounded-md border border-border" style={{ backgroundColor: hex }} aria-hidden />
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Custom colours</h3>
        <p className="text-xs text-muted-foreground">
          Each picker shows its hex value. Colours apply to the active mode; text is checked against the background.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {COLOR_FIELDS.map(({ key, label, fallback }) => {
            const value = colors[key] ?? fallback;
            return (
              <label key={key} className="flex min-h-11 items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(value) ? value : fallback}
                  disabled={pending}
                  onChange={(event) => setColor(key, event.target.value)}
                  className="size-11 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${label} colour`}
                />
                <span className="flex-1">{label}</span>
                <code className="num text-xs text-muted-foreground">{value}</code>
              </label>
            );
          })}
        </div>
        {warning ? (
          <p role="status" className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-xs text-foreground">
            <span className="font-medium">Contrast warning.</span> {warning} Save is disabled until it is resolved.
          </p>
        ) : null}
      </section>

      <RadioGroup
        label="Chart palette"
        value={draft.chartPalette}
        options={CHART_PALETTES}
        onChange={(chartPalette) => update({ chartPalette })}
      />
      <RadioGroup
        label="Density"
        value={draft.density}
        options={DENSITIES}
        onChange={(density) => update({ density })}
      />
      <RadioGroup
        label="Card corners"
        value={draft.cornerStyle}
        options={CORNERS}
        onChange={(cornerStyle) => update({ cornerStyle })}
      />

      <section className="space-y-2">
        <label htmlFor="appearance-font-size" className="text-xs font-medium text-muted-foreground">
          Font size <span className="num font-normal">{draft.fontSize}px</span>
        </label>
        <input
          id="appearance-font-size"
          type="range"
          min={12}
          max={20}
          step={1}
          value={draft.fontSize}
          disabled={pending}
          onChange={(event) => update({ fontSize: Number(event.target.value) })}
          className="appearance-font-slider w-full max-w-md"
        />
        <div className="flex max-w-md justify-between text-[0.7rem] text-muted-foreground" aria-hidden>
          <span>12</span><span>20</span>
        </div>
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
        <Button type="button" onClick={onSave} disabled={pending || Boolean(warning)} aria-busy={pending}>
          {pending ? "Saving…" : "Save appearance"}
        </Button>
        <Button type="button" variant="outline" onClick={onRestore} disabled={pending}>
          Restore defaults
        </Button>
        {!conflict ? (
          <span className="text-xs text-muted-foreground">
            Changes are previewed now and saved across devices when you press Save.
          </span>
        ) : (
          <span className="text-xs font-medium text-destructive">{CONFLICT_MESSAGE}</span>
        )}
      </div>
    </div>
  );
}
