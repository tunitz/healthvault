"use client";

import { useEffect, useState } from "react";

const PREFETCH_ROUTES = ["/", "/training", "/workouts", "/explorer", "/uploads"];

function prefetchRoutes() {
  for (const route of PREFETCH_ROUTES) {
    // Goes through the service worker fetch handler, which stores the response.
    fetch(route, { credentials: "same-origin" }).catch(() => {});
  }
}

export function SwRegister() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);

    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      const register = () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      };
      let prefetched = false;
      const maybePrefetch = () => {
        if (prefetched || !navigator.serviceWorker.controller) return;
        prefetched = true;
        prefetchRoutes();
      };

      if (document.readyState === "complete") register();
      else window.addEventListener("load", register, { once: true });

      // Prefetch once the page has loaded and the SW controls it (first visit: after controllerchange).
      const afterLoad = () => setTimeout(maybePrefetch, 0);
      navigator.serviceWorker.addEventListener("controllerchange", afterLoad);
      if (document.readyState === "complete") afterLoad();
      else window.addEventListener("load", afterLoad, { once: true });
    }

    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[calc(3.5rem+env(safe-area-inset-top)+0.5rem)] z-30 flex justify-center px-4"
    >
      <span className="rounded-full border bg-muted/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
        Offline — showing last saved data
      </span>
    </div>
  );
}
