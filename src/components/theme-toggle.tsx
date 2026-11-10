"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

type Mode = "system" | "light" | "dark";

const ORDER: Mode[] = ["system", "light", "dark"];

const META: Record<Mode, { label: string; Icon: typeof Sun }> = {
  system: { label: "System", Icon: Monitor },
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
};

// False during SSR/first paint, true once hydrated — without a setState-in-effect.
const subscribeNoop = () => () => {};
const clientTrue = () => true;
const serverFalse = () => false;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeNoop, clientTrue, serverFalse);

  if (!mounted) {
    return <span aria-hidden className="inline-block size-11 md:size-9" />;
  }

  const current: Mode = ORDER.includes(theme as Mode) ? (theme as Mode) : "system";
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const { label, Icon } = META[current];

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 text-muted-foreground hover:text-foreground md:size-9"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${label}. Switch to ${META[next].label}`}
      title={`Theme: ${label}`}
    >
      <Icon aria-hidden className="size-4" />
    </Button>
  );
}
