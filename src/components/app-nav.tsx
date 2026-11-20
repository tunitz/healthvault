"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  CookingPot,
  Dumbbell,
  History,
  LayoutDashboard,
  LogOut,
  Moon,
  MoreHorizontal,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Pill,
  Plus,
  RefreshCw,
  Route,
  Ruler,
  Search,
  Settings,
  Sun,
  Target,
  Upload,
  User,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { applyAppearance, cacheAppearance } from "@/components/theme-provider";
import { fetchSettings, saveSettings } from "@/components/dashboard/settings-api";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; Icon: LucideIcon; hint?: string };
type NavGroup = { label: string; Icon: LucideIcon; items: NavItem[] };

// The five mobile destinations are fixed: four primary tabs plus More. Logging is an action,
// not a sixth tab.
const PRIMARY = [
  { href: "/", label: "Overview", Icon: LayoutDashboard },
  { href: "/nutrition", label: "Nutrition", Icon: Utensils },
  { href: "/training", label: "Activity", Icon: Activity },
  { href: "/supplements", label: "Supplements", Icon: Pill },
] as const;

const GROUPS: NavGroup[] = [
  {
    label: "Nutrition",
    Icon: Utensils,
    items: [
      { href: "/nutrition", label: "Diary", Icon: BookOpen },
      { href: "/nutrition/foods", label: "Foods", Icon: NotebookPen },
      { href: "/nutrition/recipes", label: "Recipes", Icon: CookingPot },
      { href: "/nutrition/targets", label: "Targets", Icon: Target },
    ],
  },
  {
    label: "Activity",
    Icon: Activity,
    items: [
      { href: "/training", label: "Overview", Icon: LayoutDashboard },
      { href: "/training/plan", label: "Plan", Icon: Route },
      { href: "/training/strength", label: "Strength", Icon: Dumbbell },
      { href: "/workouts", label: "Workouts", Icon: ClipboardList },
    ],
  },
  {
    label: "Supplements",
    Icon: Pill,
    items: [
      { href: "/supplements", label: "Today", Icon: CalendarDays },
      { href: "/supplements/regimens", label: "Regimens", Icon: NotebookPen },
      { href: "/supplements/history", label: "History", Icon: History },
    ],
  },
];

const UTILITY_ITEMS: NavItem[] = [
  { href: "/profile", label: "Profile", Icon: User },
  { href: "/measurements", label: "Measurements", Icon: Ruler },
  { href: "/uploads", label: "Import", Icon: Upload },
  { href: "/settings", label: "Settings", Icon: Settings },
];

// Deep links stay reachable, but they are not primary navigation: Explorer lives under
// Settings → Data tools and past-meal corrections stay contextual to food/meal history.
const EXTRA_UTILITIES: NavItem[] = [
  { href: "/explorer", label: "Explorer", Icon: Search },
  { href: "/nutrition/corrections", label: "Past meals", Icon: History },
];

const LOG_ACTIONS: NavItem[] = [
  { href: "/nutrition", label: "Log food", hint: "Add a food or meal", Icon: Utensils },
  { href: "/supplements", label: "Log supplement", hint: "Tick today's doses", Icon: Pill },
  { href: "/measurements", label: "Log measurement", hint: "Weight, body fat, waist", Icon: Ruler },
  { href: "/training/strength", label: "Log strength set", hint: "Record lifts & reps", Icon: Dumbbell },
  { href: "/uploads", label: "Import health data", hint: "Manual Apple Health export", Icon: Upload },
];

const SIDEBAR_KEY = "hv-sidebar-collapsed";
const SIDEBAR_EVENT = "hv-sidebar-change";

// Read the persisted rail state without a setState-in-effect. The server snapshot keeps SSR and
// the first hydration render identical; the real value is adopted immediately afterwards.
function subscribeSidebar(onStoreChange: () => void) {
  window.addEventListener(SIDEBAR_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(SIDEBAR_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function getSidebarSnapshot() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function getSidebarServerSnapshot() {
  return false;
}

function pathOf(href: string) {
  return href.split("#", 1)[0];
}

function isActive(pathname: string, href: string) {
  const path = pathOf(href);
  return path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
}

function isPrimaryHref(href: string) {
  return PRIMARY.some((item) => item.href === pathOf(href));
}

function SideLink({
  item,
  active,
  collapsed = false,
  indented = false,
}: {
  item: NavItem;
  active: boolean;
  collapsed?: boolean;
  indented?: boolean;
}) {
  const { href, label, Icon } = item;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "flex min-h-10 items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
        collapsed && "justify-center px-0",
        indented && "text-[0.8125rem]",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      {!collapsed && <span className="min-w-0 truncate">{label}</span>}
    </Link>
  );
}

function SheetLink({ item, active }: { item: NavItem; active: boolean }) {
  const { href, label, hint, Icon } = item;
  return (
    <Dialog.Close asChild>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2.5 text-sm hover:bg-accent",
          active
            ? "border-primary/40 bg-muted font-medium text-foreground"
            : "border-border text-foreground",
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
      </Link>
    </Dialog.Close>
  );
}

export function AppNav({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [offline, setOffline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const collapsed = useSyncExternalStore(subscribeSidebar, getSidebarSnapshot, getSidebarServerSnapshot);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    Nutrition: true,
    Activity: true,
    Supplements: true,
  });
  const refreshInitiated = useRef(false);

  const toggleQuickTheme = useCallback(async () => {
    if (themeSaving) return;
    const nextMode = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(nextMode);
    setThemeSaving(true);
    try {
      const snapshot = await fetchSettings();
      const appearance = { ...snapshot.value.appearance, mode: nextMode as "light" | "dark" };
      applyAppearance(appearance, nextMode);
      const saved = await saveSettings({ ...snapshot.value, appearance }, snapshot.revision);
      cacheAppearance(saved.value.appearance);
    } catch {
      // Local mode toggle still applies immediately even if offline.
    } finally {
      setThemeSaving(false);
    }
  }, [resolvedTheme, setTheme, themeSaving]);

  const toggleSidebar = useCallback(() => {
    const next = !getSidebarSnapshot();
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {
      // Non-fatal: the store update below still flips the rail for this session.
    }
    window.dispatchEvent(new Event(SIDEBAR_EVENT));
  }, []);

  const toggleGroup = (label: string) => {
    setExpandedGroups((previous) => ({ ...previous, [label]: !previous[label] }));
  };

  // Track connectivity live; reading navigator.onLine during render would mismatch SSR.
  useEffect(() => {
    const syncOnline = () => setOffline(!navigator.onLine);
    syncOnline();
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    return () => {
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
    };
  }, []);

  // router.refresh() is not awaitable; the transition's pending state is the in-flight signal.
  // When it settles, record the time and report success.
  useEffect(() => {
    if (refreshInitiated.current && !isPending) {
      refreshInitiated.current = false;
      setLastUpdated(new Date());
      toast.success("Data refreshed");
    }
  }, [isPending]);

  const refresh = useCallback(() => {
    if (offline || isPending) return;
    refreshInitiated.current = true;
    startTransition(() => {
      try {
        router.refresh();
      } catch {
        refreshInitiated.current = false;
        toast.error("Could not refresh data");
      }
    });
  }, [offline, isPending, router]);

  // Bare "r" shortcut, guarded against typing, modifiers and open dialogs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.length !== 1 || event.key.toLowerCase() !== "r") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"))
      ) return;
      refresh();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [refresh]);

  const refreshTitle = offline
    ? "Refresh data · Offline"
    : lastUpdated
      ? `Refresh data · Last updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
      : "Refresh data";

  const secondaryItems = [
    ...GROUPS.flatMap((group) => group.items),
    ...UTILITY_ITEMS,
    ...EXTRA_UTILITIES,
  ];
  const moreActive =
    secondaryItems.some((item) => isActive(pathname, item.href)) &&
    !PRIMARY.some((item) => isActive(pathname, item.href));

  // Sign-in and first-run setup have no authenticated app chrome.
  if (pathname === "/login" || pathname === "/setup") return <>{children}</>;

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Still clear local state and leave the page even if the request fails.
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    // Hard navigation intentionally discards the signed-in RSC/client cache.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }

  return (
    <>
      <header className="sticky top-0 z-40 border-b bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-md text-sm font-semibold tracking-tight text-foreground"
          >
            <Logo size={24} />
            <span>HealthVault</span>
          </Link>

          <div className="ms-auto flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => setLogOpen(true)}
              aria-label="Log"
              aria-haspopup="dialog"
              aria-expanded={logOpen}
              title="Quick log"
              className="min-w-11 justify-center gap-1.5 px-2 sm:h-9 sm:px-3"
            >
              <Plus aria-hidden className="size-4" />
              <span className="hidden sm:inline">Log</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 text-muted-foreground hover:text-foreground md:size-9"
              onClick={() => void toggleQuickTheme()}
              disabled={themeSaving}
              aria-label="Toggle color theme"
              title="Switch light / dark mode"
            >
              <Sun aria-hidden className="size-4 dark:hidden" />
              <Moon aria-hidden className="hidden size-4 dark:block" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 text-muted-foreground hover:text-foreground md:size-9"
              onClick={refresh}
              disabled={offline || isPending}
              aria-label="Refresh data"
              title={refreshTitle}
            >
              <RefreshCw
                aria-hidden
                className={cn("size-4", isPending && "animate-spin motion-reduce:animate-none")}
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 text-muted-foreground hover:text-foreground md:size-9"
              onClick={signOut}
              disabled={signingOut}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 items-stretch">
        <aside
          aria-label="Workspace"
          className={cn(
            "hidden shrink-0 border-r bg-sidebar text-sidebar-foreground md:sticky md:top-14 md:flex md:h-[calc(100dvh-3.5rem)] md:flex-col",
            collapsed ? "md:w-16" : "md:w-60 lg:w-64",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2 border-b px-2 py-2",
              collapsed && "justify-center",
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              onClick={toggleSidebar}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden className="size-4" />
              ) : (
                <PanelLeftClose aria-hidden className="size-4" />
              )}
            </Button>
            {!collapsed && (
              <span className="text-xs font-medium text-muted-foreground">Workspace</span>
            )}
          </div>

          <nav aria-label="Sections" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            <ul className="space-y-1">
              <li>
                <SideLink
                  item={{ href: "/", label: "Overview", Icon: LayoutDashboard }}
                  active={isActive(pathname, "/")}
                  collapsed={collapsed}
                />
              </li>
              {GROUPS.map((group) => {
                const groupActive = group.items.some((item) => isActive(pathname, item.href));
                return (
                  <li key={group.label}>
                    {collapsed ? (
                      <SideLink
                        item={{ href: group.items[0].href, label: group.label, Icon: group.Icon }}
                        active={groupActive}
                        collapsed
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.label)}
                          aria-expanded={!!expandedGroups[group.label]}
                          className={cn(
                            "flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-sm font-medium hover:bg-sidebar-accent",
                            groupActive && "text-sidebar-accent-foreground",
                          )}
                        >
                          <group.Icon aria-hidden className="size-4 shrink-0" />
                          <span className="flex-1 text-start">{group.label}</span>
                          <ChevronDown
                            aria-hidden
                            className={cn(
                              "size-4 shrink-0 transition-transform motion-reduce:transition-none",
                              !expandedGroups[group.label] && "-rotate-90",
                            )}
                          />
                        </button>
                        {expandedGroups[group.label] && (
                          <ul className="ms-4 space-y-0.5 border-s border-sidebar-border ps-2">
                            {group.items.map((item) => (
                              <li key={item.href}>
                                <SideLink
                                  item={item}
                                  active={isActive(pathname, item.href)}
                                  indented
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="my-3 border-t border-sidebar-border" />
            <ul className="space-y-1">
              {UTILITY_ITEMS.map((item) => (
                <li key={item.href}>
                  <SideLink
                    item={item}
                    active={isActive(pathname, item.href)}
                    collapsed={collapsed}
                  />
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <div className="min-w-0 flex-1">{children}</div>
      </div>

      {/* Mobile bar: exactly five destinations. */}
      <Dialog.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden"
        >
          <ul className="flex w-full items-stretch px-2 pt-1 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
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
                    <Icon aria-hidden className="size-5 shrink-0" />
                    <span
                      className="max-w-full min-w-0 truncate text-[10px] leading-tight min-[380px]:text-[11px]"
                      title={label}
                    >
                      {label}
                    </span>
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
                <MoreHorizontal aria-hidden className="size-5 shrink-0" />
                <span className="max-w-full min-w-0 truncate px-0.5 text-[10px] leading-tight min-[380px]:text-[11px]">
                  More
                </span>
              </button>
            </li>
          </ul>
        </nav>

        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:bg-foreground/10 md:backdrop-blur-none" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t bg-background p-4 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-xl data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom md:inset-x-auto md:top-[calc(3.5rem+env(safe-area-inset-top))] md:right-4 md:bottom-auto md:w-80 md:rounded-xl md:border">
            <Dialog.Title className="text-sm font-medium">More</Dialog.Title>
            <Dialog.Description className="sr-only">
              Sections not shown in the primary navigation
            </Dialog.Description>
            <div className="mt-3 space-y-3">
              {GROUPS.map((group) => (
                <section key={group.label}>
                  <h3 className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </h3>
                  <nav aria-label={group.label} className="grid grid-cols-2 gap-2 md:grid-cols-1">
                    {group.items
                      .filter((item) => !isPrimaryHref(item.href))
                      .map((item) => (
                        <SheetLink
                          key={item.href}
                          item={item}
                          active={isActive(pathname, item.href)}
                        />
                      ))}
                  </nav>
                </section>
              ))}
              <section>
                <h3 className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Other
                </h3>
                <nav aria-label="Other" className="grid grid-cols-2 gap-2 md:grid-cols-1">
                  {[...UTILITY_ITEMS, ...EXTRA_UTILITIES].map((item) => (
                    <SheetLink
                      key={item.href}
                      item={item}
                      active={isActive(pathname, item.href)}
                    />
                  ))}
                </nav>
              </section>
              <section>
                <h3 className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Actions
                </h3>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    onClick={refresh}
                    disabled={offline || isPending}
                    aria-label="Refresh data"
                    title={refreshTitle}
                    className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border px-3 py-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
                  >
                    <RefreshCw
                      aria-hidden
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground",
                        isPending && "animate-spin motion-reduce:animate-none",
                      )}
                    />
                    <span className="min-w-0 truncate">Refresh data</span>
                  </button>
                </Dialog.Close>
              </section>
            </div>
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

      {/* Global Log shortcut — an action menu, never a navigation destination. */}
      <Dialog.Root open={logOpen} onOpenChange={setLogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed inset-x-3 top-1/2 z-50 max-w-md -translate-y-1/2 rounded-xl border bg-background p-4 shadow-xl data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-x-auto sm:left-1/2 sm:w-[560px] sm:max-w-[calc(100vw-3rem)] sm:-translate-x-1/2 sm:p-5">
            <Dialog.Title className="text-sm font-medium">Quick log</Dialog.Title>
            <Dialog.Description className="sr-only">
              Choose what you want to record
            </Dialog.Description>
            <nav aria-label="Logging actions" className="mt-3 grid gap-2">
              {LOG_ACTIONS.map((item) => (
                <SheetLink key={item.href} item={item} active={false} />
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
