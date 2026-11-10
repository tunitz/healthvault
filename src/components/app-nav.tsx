"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Dumbbell, LayoutDashboard, MoreHorizontal, Pill, Search, Upload, UserRound, Utensils } from "lucide-react";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const PRIMARY = [
  { href: "/", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/training", label: "Training", Icon: Activity },
  { href: "/nutrition", label: "Nutrition", Icon: Utensils },
  { href: "/supplements", label: "Supplements", Icon: Pill },
] as const;

const MORE = [
  { href: "/workouts", label: "Workouts", Icon: Dumbbell },
  { href: "/explorer", label: "Explorer", Icon: Search },
  { href: "/profile", label: "Profile", Icon: UserRound },
  { href: "/uploads", label: "Import", Icon: Upload },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE.some((item) => isActive(pathname, item.href));

  return (
    <>
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:px-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-md text-sm font-semibold tracking-tight text-foreground"
          >
            <Logo size={24} />
            <span>Health Vault</span>
          </Link>

          <nav aria-label="Primary" className="hidden flex-1 items-center gap-0.5 md:flex">
            {[...PRIMARY, ...MORE].map(({ href, label }) => {
              const active = isActive(pathname, href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs transition-colors lg:px-3 lg:text-sm",
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

          <div className="ml-auto md:ml-0">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <Dialog.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden"
        >
          <ul className="mx-auto flex max-w-6xl items-stretch px-2 pt-1 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
            {PRIMARY.map(({ href, label, Icon }) => {
              const active = isActive(pathname, href);
              return (
                <li key={href} className="flex flex-1">
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-16 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium transition-colors",
                      active ? "text-primary" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon aria-hidden className="size-5" />
                    <span>{label}</span>
                  </Link>
                </li>
              );
            })}
            <li className="flex flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                aria-expanded={moreOpen}
                aria-haspopup="dialog"
                className={cn(
                  "flex min-h-16 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium transition-colors",
                  moreActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <MoreHorizontal aria-hidden className="size-5" />
                <span>More</span>
              </button>
            </li>
          </ul>
        </nav>

        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t bg-background p-4 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-xl data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom md:hidden">
            <Dialog.Title className="text-sm font-medium">More</Dialog.Title>
            <Dialog.Description className="sr-only">Sections not shown in the bottom bar</Dialog.Description>
            <nav aria-label="More" className="mt-3 grid grid-cols-2 gap-2">
              {MORE.map(({ href, label, Icon }) => (
                <Dialog.Close asChild key={href}>
                  <Link
                    href={href}
                    aria-current={isActive(pathname, href) ? "page" : undefined}
                    className="flex items-center gap-2 rounded-lg border border-border px-3 py-3 text-sm text-foreground hover:bg-accent"
                  >
                    <Icon aria-hidden className="size-4 text-muted-foreground" />
                    {label}
                  </Link>
                </Dialog.Close>
              ))}
            </nav>
            <div className="mt-3 flex justify-end">
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
