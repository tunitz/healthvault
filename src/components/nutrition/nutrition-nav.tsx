"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/nutrition", label: "Day" },
  { href: "/nutrition/foods", label: "Foods" },
  { href: "/nutrition/recipes", label: "Recipes" },
  { href: "/nutrition/corrections", label: "Past meals" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/nutrition" ? pathname === "/nutrition" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The nutrition section's own sub-navigation. Links are real anchors (server components can render
 * this from any nutrition page); only the current-item marker needs the pathname.
 */
export function NutritionNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Nutrition sections" className="flex flex-wrap gap-1">
      {SECTIONS.map(({ href, label }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-md px-2.5 text-sm transition-colors sm:min-h-0 sm:py-1.5",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
