/**
 * Appearance helpers: mode-aware presets, per-mode custom-colour precedence, contrast safeguards,
 * dual-variant pre-paint caching and the pure mapping from preferences to CSS variables.
 */
import { describe, expect, test } from "bun:test";
import {
  appearanceToCss,
  cacheAppearance,
  contrastRatio,
  contrastWarning,
  CUSTOM_PRESET,
  effectiveColors,
  hexToRgb,
  pickBootstrapVariant,
  PRESETS,
  presetById,
  readableForeground,
  relativeLuminance,
  resolveMode,
  type AppearanceCache,
} from "@/components/theme-provider";
import { defaultAppearance } from "@/components/dashboard/defaults";
import type { AppearanceSettings } from "@/lib/services/settings";

function appearance(patch: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return { ...defaultAppearance(), ...patch };
}

describe("appearance presets and colours", () => {
  test("presets keep stable stored ids and labels", () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual(["default", "ocean", "forest", "sunset", "mono"]);
    expect(PRESETS.map((preset) => preset.label)).toEqual(["Teal", "Ocean", "Forest", "Sunset", "Slate"]);
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length);
    expect(presetById("ocean")?.label).toBe("Ocean");
    expect(presetById("missing")).toBeNull();
  });

  test("every preset carries a distinct light and dark set", () => {
    for (const preset of PRESETS) {
      expect(preset.light).toBeDefined();
      expect(preset.dark).toBeDefined();
      expect(preset.chartPalette).toBeDefined();
      const lightBg = preset.light.background;
      const darkBg = preset.dark.background;
      if (lightBg) expect(relativeLuminance(lightBg)!).toBeGreaterThan(0.6);
      if (darkBg) expect(relativeLuminance(darkBg)!).toBeLessThan(0.12);
      if (lightBg && darkBg) expect(darkBg).not.toBe(lightBg);
    }
  });

  test("mode picker values resolve to a concrete variant", () => {
    expect(resolveMode("light")).toBe("light");
    expect(resolveMode("dark")).toBe("dark");
    expect(["light", "dark"]).toContain(resolveMode("system"));
    expect(["light", "dark"]).toContain(resolveMode(undefined));
  });

  test("effectiveColors uses the preset and custom colours of the resolved mode only", () => {
    const value = appearance({
      preset: "ocean",
      mode: "dark",
      customColors: { accent: "#123456" },
      customColorsDark: { accent: "#abcdef" },
    });
    expect(effectiveColors(value, "light").accent).toBe("#123456");
    expect(effectiveColors(value, "light").background).toBe("#f6f8ff");
    expect(effectiveColors(value, "dark").accent).toBe("#abcdef");
    expect(effectiveColors(value, "dark").background).toBe("#0f1626");
    expect(effectiveColors(value).accent).toBe("#abcdef"); // appearance.mode is authoritative when no mode is passed
  });

  test("a custom edit in one mode never leaks into the other", () => {
    const dark = appearance({ preset: "ocean", customColorsDark: { background: "#000000" } });
    expect(effectiveColors(dark, "dark").background).toBe("#000000");
    expect(effectiveColors(dark, "light").background).toBe("#f6f8ff");
    const light = appearance({ preset: "ocean", customColors: { background: "#ffffff" } });
    expect(effectiveColors(light, "light").background).toBe("#ffffff");
    expect(effectiveColors(light, "dark").background).toBe("#0f1626");
  });

  test("custom colours merge over the preset without dropping its other tokens", () => {
    const value = appearance({ preset: "ocean", customColors: { accent: "#123456" } });
    expect(effectiveColors(value).accent).toBe("#123456");
    expect(effectiveColors(value).background).toBe("#f6f8ff");
    expect(effectiveColors(value).foreground).toBe("#17223a");
  });

  test("hex parsing and contrast ratio are correct", () => {
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#112233")).toEqual({ r: 17, g: 34, b: 51 });
    expect(hexToRgb("red")).toBeNull();
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 1);
    expect(readableForeground("#ffffff")).toBe("#111827");
    expect(readableForeground("#000000")).toBe("#ffffff");
  });

  test("every colour-bearing preset is readable in both modes", () => {
    for (const preset of PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const colors = effectiveColors(appearance({ preset: preset.id, mode }), mode);
        if (!colors.background || !colors.foreground) {
          // The default preset intentionally carries no overrides: globals.css owns those tokens.
          expect(preset.id).toBe("default");
          continue;
        }
        expect(contrastRatio(colors.background, colors.foreground)!).toBeGreaterThanOrEqual(4.5);
        expect(contrastWarning(appearance({ preset: preset.id, mode }), mode)).toBeNull();
      }
    }
  });

  test("defaults have no contrast warning; unreadable pairs are flagged in the chosen mode", () => {
    expect(contrastWarning(appearance())).toBeNull();
    const bad = appearance({ customColorsDark: { background: "#ffffff", foreground: "#ffffff" } });
    expect(contrastWarning(bad, "dark")).toContain("contrast");
    expect(contrastWarning(bad, "dark")).toContain("4.5:1");
    expect(contrastWarning(bad, "light")).toBeNull();
    const invalid = appearance({ customColors: { background: "not-a-colour" } });
    expect(contrastWarning(invalid, "light")).toContain("valid hex");
  });
});

describe("appearance → CSS mapping", () => {
  test("density, corners, chart palette and font size become data attributes", () => {
    const css = appearanceToCss(appearance({ density: "compact", cornerStyle: "square", chartPalette: "vibrant", fontSize: 18 }));
    expect(css.dataset).toEqual({ density: "compact", corners: "square", chartPalette: "vibrant" });
    expect(css.fontSizePx).toBe(18);
  });

  test("default preset applies no inline colour overrides in either mode", () => {
    expect(appearanceToCss(appearance(), "light").vars).toEqual({});
    expect(appearanceToCss(appearance(), "dark").vars).toEqual({});
  });

  test("accent maps to primary controls and gets readable foreground in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const vars = appearanceToCss(appearance({ preset: CUSTOM_PRESET, customColors: { accent: "#ffffff" }, customColorsDark: { accent: "#ffffff" } }), mode).vars;
      expect(vars["--primary"]).toBe("#ffffff");
      expect(vars["--ring"]).toBe("#ffffff");
      expect(vars["--primary-foreground"]).toBe("#111827");
    }
  });

  test("a custom background auto-derives readable text when none is given", () => {
    const vars = appearanceToCss(appearance({ customColors: { background: "#ffffff" } }), "light").vars;
    expect(vars["--background"]).toBe("#ffffff");
    expect(vars["--foreground"]).toBe("#111827");
  });

  test("custom foreground and border are honoured", () => {
    const vars = appearanceToCss(appearance({ customColors: { foreground: "#101010", border: "#aaaaaa" } }), "light").vars;
    expect(vars["--foreground"]).toBe("#101010");
    expect(vars["--border"]).toBe("#aaaaaa");
    expect(vars["--input"]).toBe("#aaaaaa");
  });

  test("a dark preset never emits a light background inline", () => {
    for (const preset of PRESETS) {
      const vars = appearanceToCss(appearance({ preset: preset.id }), "dark").vars;
      if (vars["--background"]) expect(relativeLuminance(vars["--background"])!).toBeLessThan(0.12);
    }
  });
});

describe("dual-variant persistence and pre-paint selection", () => {
  test("cacheAppearance stores both mode variants", () => {
    const original = globalThis.localStorage;
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    };
    try {
      cacheAppearance(appearance({
        preset: "ocean",
        chartPalette: "vibrant",
        customColors: { accent: "#111111" },
        customColorsDark: { accent: "#eeeeee" },
      }));
      const cache = JSON.parse(store.get("hv-appearance-css")!) as AppearanceCache;
      expect(cache.light.vars["--primary"]).toBe("#111111");
      expect(cache.dark.vars["--primary"]).toBe("#eeeeee");
      expect(cache.light.dataset.chartPalette).toBe("vibrant");
    } finally {
      (globalThis as { localStorage?: Storage }).localStorage = original;
    }
  });

  test("bootstrap picks dark colours only for a dark stored/system theme", () => {
    const cache = {
      light: { dataset: { density: "comfortable", corners: "rounded", chartPalette: "default" }, fontSizePx: 14, vars: { "--background": "#f6f8ff" } },
      dark: { dataset: { density: "comfortable", corners: "rounded", chartPalette: "default" }, fontSizePx: 14, vars: { "--background": "#0f1626" } },
    } as AppearanceCache;
    expect(pickBootstrapVariant(cache, "dark", false)!.vars["--background"]).toBe("#0f1626");
    expect(pickBootstrapVariant(cache, "light", true)!.vars["--background"]).toBe("#f6f8ff");
    expect(pickBootstrapVariant(cache, "system", true)!.vars["--background"]).toBe("#0f1626");
    expect(pickBootstrapVariant(cache, null, false)!.vars["--background"]).toBe("#f6f8ff");
    expect(pickBootstrapVariant(null, "dark", false)).toBeNull();
  });
});
