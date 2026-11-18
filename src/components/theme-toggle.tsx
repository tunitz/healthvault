"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThemeMode } from "@/lib/services/settings";

type Mode = ThemeMode;

const MODES: { value: Mode; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

// False during SSR/first paint, true once hydrated — avoids a setState-in-effect flash.
const subscribeNoop = () => () => {};
const clientTrue = () => true;
const serverFalse = () => false;

/**
 * Theme is switched only from Settings → Appearance. Native radios keep selection, focus and
 * screen-reader semantics without a custom ARIA widget. When used inside the appearance form the
 * caller owns the value and handles the change (preview now, persist on Save); uncontrolled use
 * still talks to next-themes directly.
 */
export function ThemeModePicker({
  value,
  onChange,
  disabled = false,
}: {
  value?: Mode;
  onChange?: (mode: Mode) => void;
  disabled?: boolean;
} = {}) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeNoop, clientTrue, serverFalse);
  const fromProvider: Mode = MODES.some((mode) => mode.value === theme) ? (theme as Mode) : "system";
  const current = value ?? fromProvider;

  function select(mode: Mode) {
    if (onChange) onChange(mode);
    else setTheme(mode);
  }

  return (
    <div role="radiogroup" aria-label="Color theme" className="grid grid-cols-3 gap-2 sm:max-w-md">
      {MODES.map(({ value: mode, label, Icon }) => {
        const selected = mounted && current === mode;
        return (
          <label
            key={mode}
            className={cn(
              "flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border px-2 py-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring",
              disabled && "pointer-events-none opacity-60",
              selected
                ? "border-primary bg-primary/10 font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            <input
              type="radio"
              name="theme-mode"
              value={mode}
              checked={selected}
              onChange={() => select(mode)}
              disabled={disabled}
              className="sr-only"
            />
            <Icon aria-hidden className="size-5 shrink-0" />
            <span>{label}</span>
            {/* Text, not colour alone, marks the active mode. */}
            {selected ? <span className="sr-only">selected</span> : null}
          </label>
        );
      })}
    </div>
  );
}
