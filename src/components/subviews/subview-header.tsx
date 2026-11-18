import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared heading + parent back-link for focused subviews. Sections render their own sibling
 * navigation through SubviewNav so these pages stay server components with no client JS.
 */
export function SubviewHeader({
  title,
  description,
  backHref,
  backLabel,
  children,
}: {
  title: string;
  description?: string;
  backHref: string;
  backLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Link
          href={backHref}
          className="inline-flex min-h-11 w-fit items-center gap-1.5 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:min-h-0"
        >
          <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
          {backLabel}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** Sibling navigation for one section. `activeHref` is supplied by the page that knows where it is. */
export function SubviewNav({
  label,
  items,
  activeHref,
}: {
  label: string;
  items: readonly { href: string; label: string }[];
  activeHref: string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1">
      {items.map((item) => {
        const active = item.href === activeHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-md px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:min-h-0 sm:py-1.5",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
