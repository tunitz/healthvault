"use client";

import { useCallback, useEffect, useState } from "react";
import {
  clearQuickLog,
  getQuickLogTarget,
  QUICK_LOG_EVENT,
} from "@/lib/quick-log";

/**
 * Opens a logging dialog from the global Quick log menu or from a direct #log-* link.
 * The menu stores its target on `window` and fires an event, which also works when the menu is
 * used again while the user is already on the destination page.
 */
export function useAutoOpenHash(hash: string) {
  const [open, setOpenState] = useState(false);

  useEffect(() => {
    const checkHash = () => {
      if (window.location.hash.startsWith(hash)) setOpenState(true);
    };
    const checkQuickLog = () => {
      if (getQuickLogTarget() === hash) setOpenState(true);
    };
    checkHash();
    checkQuickLog();
    window.addEventListener("hashchange", checkHash);
    window.addEventListener(QUICK_LOG_EVENT, checkQuickLog);
    return () => {
      window.removeEventListener("hashchange", checkHash);
      window.removeEventListener(QUICK_LOG_EVENT, checkQuickLog);
    };
  }, [hash]);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (!next) clearQuickLog();
    },
    [],
  );

  return [open, setOpen] as const;
}
