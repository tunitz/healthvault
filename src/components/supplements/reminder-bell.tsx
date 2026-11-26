"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

const ENABLED_KEY = "hv:reminder-enabled";
const FIRED_PREFIX = "hv:reminder-fired:";
/** Same-tab change signal; the browser's `storage` event only reaches other tabs. */
const ENABLED_EVENT = "hv:reminder-enabled-change";

type ReminderItem = {
  supplement: { id: number; name: string; dose: number; unit: string };
  schedule: { time: string | null };
  due: boolean;
  dueAtMs: number;
};

type DueReminders = {
  day: string;
  /** All due items; optional for compatibility with responses from older servers. */
  items?: ReminderItem[];
  /** Earliest due item from older servers, retained as a client fallback. */
  item?: ReminderItem | null;
};

function subscribeEnabled(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(ENABLED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(ENABLED_EVENT, onChange);
  };
}

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    // Storage can be blocked; behave like the default (off) instead of crashing the render.
    return false;
  }
}

const enabledServerSnapshot = () => false;

function subscribeSupported(): () => void {
  return () => {};
}
const supportedSnapshot = () => "Notification" in window;
/** Match the old initial render (enabled) so hydration swaps only if support is missing. */
const supportedServerSnapshot = () => true;

/**
 * Optional, minimal reminder: while this tab is open it asks the session-guarded
 * `/api/reminders/next` once a minute and shows at most one browser notification per
 * due supplement and local day. Off by default; the enabled flag and fired keys live in
 * localStorage, never on the server.
 *
 * Browser-only state is read through `useSyncExternalStore` rather than set from an effect:
 * the server and hydration render the default (reminders off; support assumed), then the
 * client re-renders with the stored flag and the real capability check. That is
 * hydration-safe without a setState-in-effect.
 */
export function ReminderBell() {
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, enabledServerSnapshot);
  const supported = useSyncExternalStore(
    subscribeSupported,
    supportedSnapshot,
    supportedServerSnapshot,
  );
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    async function poll() {
      try {
        const response = await fetch("/api/reminders/next", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as DueReminders;
        const items = Array.isArray(data?.items) ? data.items : data?.item ? [data.item] : [];
        if (!("Notification" in window) || Notification.permission !== "granted") return;

        for (const item of items) {
          if (!item.due) continue;
          const key = `${FIRED_PREFIX}${data.day}:${item.supplement.id}`;
          if (window.localStorage.getItem(key) === "1") continue;

          const { name, dose, unit } = item.supplement;
          new Notification(name, {
            body: `${dose} ${unit}${item.schedule.time ? ` · ${item.schedule.time}` : ""}`,
            tag: key,
          });
          window.localStorage.setItem(key, "1");
        }
      } catch {
        // Offline or a transient failure: the next minute's poll tries again.
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), 60_000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  function persistEnabled(on: boolean): boolean {
    try {
      window.localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    } catch {
      setStatus("This browser could not save the reminder setting.");
      return false;
    }
    window.dispatchEvent(new Event(ENABLED_EVENT));
    return true;
  }

  async function toggle() {
    if (enabled) {
      if (persistEnabled(false)) setStatus("Reminders off.");
      return;
    }
    if (!("Notification" in window)) {
      setStatus("This browser does not support notifications.");
      return;
    }
    try {
      const permission =
        Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("Notification permission was not granted.");
        return;
      }
    } catch {
      setStatus("Notification permission could not be requested.");
      return;
    }
    if (persistEnabled(true)) setStatus("Reminders on.");
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant={enabled ? "secondary" : "outline"}
        aria-pressed={enabled}
        onClick={toggle}
        disabled={!supported}
      >
        {enabled ? "Reminders on" : "Remind me"}
      </Button>
      <p className="text-xs text-muted-foreground">
        {supported
          ? "Works only while HealthVault is open in a browser tab; checked once a minute."
          : "Notifications are not available in this browser."}
      </p>
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </div>
  );
}
