"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Database,
  LayoutDashboard,
  Palette,
  Plug,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Section = { href: string; label: string; Icon: LucideIcon; exact?: boolean };

export const SETTINGS_SECTIONS: Section[] = [
  { href: "/settings/appearance", label: "Appearance", Icon: Palette },
  { href: "/settings/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/settings/security", label: "Security", Icon: ShieldCheck },
  { href: "/settings/mcp", label: "MCP", Icon: Plug },
  { href: "/settings/data-tools", label: "Data tools", Icon: Database },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto pb-1 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:pb-0"
    >
      {SETTINGS_SECTIONS.map(({ href, label, Icon, exact }) => {
        const active = exact
          ? pathname === href
          : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
