"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { AppearanceSettings, ChartPalette, CustomColors, ThemeMode } from "@/lib/services/settings";

/* ----------------------------------------------------------------------------------------------
 * Mode-aware presets. Each preset carries a light and a dark colour set; effectiveColors() picks
 * the set for the resolved mode ("system" follows matchMedia). "default" deliberately carries no
 * inline overrides so the tokens in globals.css stay in charge in BOTH modes. Explicit per-mode
 * custom colours win over the preset's colours. Preset ids and labels are stable stored values.
 * -------------------------------------------------------------------------------------------- */

export type ThemePreset = {
  id: string;
  label: string;
  light: CustomColors;
  dark: CustomColors;
  chartPalette: ChartPalette;
};

export const PRESETS: readonly ThemePreset[] = [
  { id: "default", label: "Teal", light: {}, dark: {}, chartPalette: "default" },
  {
    id: "ocean",
    label: "Ocean",
    light: { accent: "#2563eb", background: "#f6f8ff", foreground: "#17223a", muted: "#e8eefb", border: "#cbd7ea" },
    dark: { accent: "#60a5fa", background: "#0f1626", foreground: "#e6edf9", muted: "#1b2740", border: "#2b3a55" },
    chartPalette: "vibrant",
  },
  {
    id: "forest",
    label: "Forest",
    light: { accent: "#15803d", background: "#f7faf5", foreground: "#1b2b1d", muted: "#e8f0e5", border: "#cbdcc6" },
    dark: { accent: "#4ade80", background: "#101a12", foreground: "#e6f2e6", muted: "#182619", border: "#2a3d2d" },
    chartPalette: "default",
  },
  {
    id: "sunset",
    label: "Sunset",
    light: { accent: "#c2410c", background: "#fff8f4", foreground: "#2e1b12", muted: "#f7e9df", border: "#eed5c6" },
    dark: { accent: "#fb923c", background: "#1f1410", foreground: "#f9ece4", muted: "#2c1d16", border: "#4a2f22" },
    chartPalette: "vibrant",
  },
  {
    id: "mono",
    label: "Slate",
    light: { accent: "#475569", background: "#f8fafc", foreground: "#1e293b", muted: "#eef2f6", border: "#d6dee8" },
    dark: { accent: "#94a3b8", background: "#14181f", foreground: "#e8edf3", muted: "#1e242d", border: "#333c48" },
    chartPalette: "monochrome",
  },
] as const;

export const CUSTOM_PRESET = "custom";

export function presetById(id: string): ThemePreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Resolve "system" to a concrete variant; safe during SSR and in the Bun test environment. */
export function resolveMode(mode: ThemeMode | undefined): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/** Preset colours for the resolved mode plus that mode's custom colours (custom values win). */
export function effectiveColors(appearance: AppearanceSettings, mode?: ThemeMode): CustomColors {
  const variant = resolveMode(mode ?? appearance.mode);
  const preset = presetById(appearance.preset);
  const presetColors = preset ? preset[variant] : {};
  const custom = variant === "dark" ? appearance.customColorsDark : appearance.customColors;
  return { ...presetColors, ...(custom ?? {}) };
}

/* ----------------------------------------------------------------------------------------------
 * Contrast safeguards — W3C relative luminance / contrast ratio.
 * -------------------------------------------------------------------------------------------- */

export type Rgb = { r: number; g: number; b: number };

export function hexToRgb(hex: string | undefined | null): Rgb | null {
  if (!hex) return null;
  let value = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) value = value.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const int = Number.parseInt(value, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b);
}

/** WCAG contrast ratio, 1–21. Returns null when either colour is not a hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Pick black or near-white text for a background so buttons stay readable in both modes. */
export function readableForeground(background: string): string {
  const luminance = relativeLuminance(background);
  return luminance !== null && luminance > 0.35 ? "#111827" : "#ffffff";
}

/** Warn (never silently correct) when the chosen text/background pair is unreadable. */
export function contrastWarning(appearance: AppearanceSettings, mode?: ThemeMode): string | null {
  const colors = effectiveColors(appearance, mode);
  if (!colors.background && !colors.foreground) return null;
  const background = colors.background ?? "#f7f8fa";
  const foreground = colors.foreground ?? readableForeground(background);
  const ratio = contrastRatio(background, foreground);
  if (ratio === null) return "Enter valid hex colours (for example #2563eb).";
  if (ratio < 4.5) {
    return `Text and background contrast is only ${ratio.toFixed(1)}:1 (need 4.5:1). Choose a lighter background or darker text.`;
  }
  return null;
}

/* ----------------------------------------------------------------------------------------------
 * Translating appearance preferences into CSS custom properties / data attributes.
 * -------------------------------------------------------------------------------------------- */

export type AppliedCss = {
  dataset: { density: string; corners: string; chartPalette: string };
  fontSizePx: number;
  vars: Record<string, string>;
};

const COLOR_TARGETS: Record<keyof CustomColors, readonly string[]> = {
  accent: ["--primary", "--ring", "--sidebar-primary", "--chart-1"],
  background: ["--background", "--card", "--popover", "--sidebar"],
  foreground: ["--foreground", "--card-foreground", "--popover-foreground", "--sidebar-foreground"],
  muted: ["--muted"],
  border: ["--border", "--input", "--sidebar-border"],
};

/** Pure mapping used by the live preview, the load-time applier and the test suite. */
export function appearanceToCss(appearance: AppearanceSettings, mode?: ThemeMode): AppliedCss {
  const vars: Record<string, string> = {};
  const colors = effectiveColors(appearance, mode);
  for (const [key, targets] of Object.entries(COLOR_TARGETS) as [keyof CustomColors, readonly string[]][]) {
    const color = colors[key];
    if (!color) continue;
    for (const token of targets) vars[token] = color;
    if (key === "accent") vars["--primary-foreground"] = readableForeground(color);
    if (key === "background" && !colors.foreground) {
      const foreground = readableForeground(color);
      for (const token of COLOR_TARGETS.foreground) vars[token] = foreground;
    }
  }
  return {
    dataset: { density: appearance.density, corners: appearance.cornerStyle, chartPalette: appearance.chartPalette },
    fontSizePx: appearance.fontSize,
    vars,
  };
}

const MANAGED_VARS = [
  "--primary", "--primary-foreground", "--ring", "--background", "--foreground",
  "--card", "--card-foreground", "--popover", "--popover-foreground",
  "--muted", "--border", "--input", "--sidebar", "--sidebar-foreground",
  "--sidebar-primary", "--sidebar-border", "--chart-1",
] as const;

/** Apply a preference object to the live document (server-synced caller passes the authority). */
export function applyAppearance(appearance: AppearanceSettings, mode?: ThemeMode): void {
  if (typeof document === "undefined") return;
  const applied = appearanceToCss(appearance, mode);
  const root = document.documentElement;
  root.dataset.density = applied.dataset.density;
  root.dataset.corners = applied.dataset.corners;
  root.dataset.chartPalette = applied.dataset.chartPalette;
  root.style.fontSize = `${applied.fontSizePx}px`;
  for (const token of MANAGED_VARS) root.style.removeProperty(token);
  for (const [token, value] of Object.entries(applied.vars)) root.style.setProperty(token, value);
}

/* ----------------------------------------------------------------------------------------------
 * Pre-paint cache. BOTH mode variants are cached so a dark session never flashes light colours:
 * the inline BOOTSTRAP chooses the variant from next-themes' localStorage key + matchMedia, the
 * same inputs next-themes uses to set the `dark` class. `pickBootstrapVariant` is the pure mirror
 * of that inline choice, kept separately so it can be verified in tests.
 * -------------------------------------------------------------------------------------------- */

export type CachedCss = AppliedCss;
export type AppearanceCache = { light: AppliedCss; dark: AppliedCss };

export function pickBootstrapVariant(
  cache: AppearanceCache | null,
  storedTheme: string | null,
  systemDark: boolean,
): AppliedCss | null {
  if (!cache) return null;
  const mode = storedTheme === "dark" || storedTheme === "light" ? storedTheme : systemDark ? "dark" : "light";
  return mode === "dark" ? cache.dark : cache.light;
}

const CACHE_KEY = "hv-appearance-css";

/** Only explicitly saved preferences are cached, so an unsaved preview never survives a reload. */
export function cacheAppearance(appearance: AppearanceSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    const cache: AppearanceCache = {
      light: appearanceToCss(appearance, "light"),
      dark: appearanceToCss(appearance, "dark"),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage may be unavailable or full — the server remains authoritative */
  }
}

const BOOTSTRAP = `(function(){try{
var c=JSON.parse(localStorage.getItem('${CACHE_KEY}')||'null');
var t=localStorage.getItem('theme');
var sd=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
var m=(t==='dark'||t==='light')?t:(sd?'dark':'light');
var v=c&&(m==='dark'?c.dark:c.light);
var r=document.documentElement;
var managed=${JSON.stringify(MANAGED_VARS)};
for(var i=0;i<managed.length;i++){r.style.removeProperty(managed[i]);}
if(v){var vs=v.vars||{};for(var k in vs){r.style.setProperty(k,vs[k]);}
if(v.dataset){r.dataset.density=v.dataset.density||'comfortable';r.dataset.corners=v.dataset.corners||'rounded';r.dataset.chartPalette=v.dataset.chartPalette||'default';}
if(v.fontSizePx){r.style.fontSize=v.fontSizePx+'px';}}
}catch(e){}})();`;

/** Re-apply the server copy on load; next-themes keeps light/dark/system independent. */
function SettingsApplier({
  children,
  initialAppearance,
}: {
  children: ReactNode;
  initialAppearance?: AppearanceSettings;
}) {
  const { setTheme } = useTheme();
  const pathname = usePathname();
  const appliedModeRef = useRef(false);
  useEffect(() => {
    if (initialAppearance) {
      applyAppearance(initialAppearance);
      cacheAppearance(initialAppearance);
      if (!appliedModeRef.current) {
        appliedModeRef.current = true;
        setTheme(initialAppearance.mode);
      }
      return;
    }
    if (pathname === "/login" || pathname === "/setup") return;
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { value?: { appearance?: AppearanceSettings } } | null) => {
        if (cancelled) return;
        const appearance = body?.value?.appearance;
        if (!appearance) return;
        applyAppearance(appearance);
        cacheAppearance(appearance);
        // The server's mode is authoritative on first load only. Re-asserting it later would
        // overwrite a mode the user is previewing in AppearanceForm.
        if (!appliedModeRef.current) {
          appliedModeRef.current = true;
          setTheme(appearance.mode);
        }
      })
      .catch(() => {
        /* signed-out pages simply keep the current theme */
      });
    return () => {
      cancelled = true;
    };
  }, [initialAppearance, pathname, setTheme]);
  return <>{children}</>;
}

export function ThemeProvider({
  children,
  initialAppearance,
  ...props
}: ComponentProps<typeof NextThemesProvider> & { initialAppearance?: AppearanceSettings }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP }} />
      <SettingsApplier initialAppearance={initialAppearance}>{children}</SettingsApplier>
    </NextThemesProvider>
  );
}
