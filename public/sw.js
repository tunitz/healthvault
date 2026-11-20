// Health Vault service worker: read-only offline cache.
// Bump VERSION whenever cache layout or caching rules change.
const VERSION = "v5";
const CACHE = `healthvault-${VERSION}`;
const MAX_CACHE_ENTRIES = 60;
const NETWORK_TIMEOUT_MS = 4000;
const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HealthVault (offline)</title>
<style>
  html,body{margin:0;height:100%;font-family:system-ui,-apple-system,sans-serif;background:#f7f8fa;color:#16181c}
  @media (prefers-color-scheme:dark){html,body{background:#16181c;color:#e6e8ec}}
  main{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;gap:12px}
  p{color:#6b7280;font-size:14px;margin:0;max-width:340px}
  .actions{display:flex;gap:10px;margin-top:8px}
  a,button{font:inherit;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;background:transparent;color:inherit;text-decoration:none;cursor:pointer}
  @media (prefers-color-scheme:dark){a,button{border-color:#374151}}
</style></head>
<body><main><h1 style="font-size:20px;margin:0">Offline and this page isn&rsquo;t cached</h1>
<p>Connect to the network once to load this page. Pages you have visited remain available offline.</p>
<div class="actions"><button onclick="location.reload()">Try again</button><a href="/">Dashboard</a></div></main></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("healthvault-") && k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/manifest.json" ||
    url.pathname.startsWith("/icon") ||
    url.pathname.startsWith("/apple-icon") ||
    /\.(png|svg|ico|webp|jpg|jpeg)$/i.test(url.pathname)
  );
}

function isNextRouterFlightRequest(request, url) {
  return (
    request.headers.has("RSC") ||
    request.headers.has("Next-Router-State-Tree") ||
    request.headers.has("Next-Router-Prefetch") ||
    request.headers.has("Next-Router-Segment-Prefetch") ||
    url.searchParams.has("_rsc")
  );
}

async function putBounded(cache, request, response) {
  try {
    await cache.put(request, response);
    const keys = await cache.keys();
    if (keys.length > MAX_CACHE_ENTRIES) {
      const excess = keys.length - MAX_CACHE_ENTRIES;
      await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
    }
  } catch {
    // Best-effort cache write; quota errors must not break responses.
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.status === 200) {
    putBounded(cache, request, response.clone());
  }
  return response;
}

async function networkFirst(request, isNavigation) {
  const cache = await caches.open(CACHE);

  const network = fetch(request).then((response) => {
    const contentType = response.headers.get("Content-Type") || "";
    const cacheable =
      response.ok &&
      response.status === 200 &&
      (!isNavigation || contentType.includes("text/html"));
    if (cacheable) {
      putBounded(cache, request, response.clone());
    }
    return response;
  });

  // Keep the network request alive in the background; only race it against the timeout.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });

  try {
    const fresh = await Promise.race([network, timeout]);
    if (fresh) return fresh;
  } catch {
    // network error: fall through to cache
  } finally {
    clearTimeout(timer);
  }

  const cached = await cache.match(request);
  if (cached) return cached;

  if (isNavigation) {
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Non-navigation with nothing cached: let the original failure surface.
  try {
    return await network;
  } catch {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept Next.js App Router RSC Flight or prefetch requests so text/x-component
  // payloads can never collide with text/html document responses in CacheStorage.
  if (isNextRouterFlightRequest(request, url)) return;
  // API responses are live data: caching them made the Explorer show yesterday's numbers
  // (and /api/type-stats is a ~1M-row scan, so it must not be replayed from a stale cache).
  if (url.pathname.startsWith("/api/")) return;
  // Sign-in, first-run setup and security settings are session/credential state and must always
  // hit the network — a cached setup screen must never survive setup or a password change.
  if (
    url.pathname === "/login" || url.pathname.startsWith("/login/") ||
    url.pathname === "/setup" || url.pathname.startsWith("/setup/") ||
    url.pathname === "/settings" || url.pathname.startsWith("/settings/")
  ) return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  const isNavigation = request.mode === "navigate";
  if (!isNavigation) return;
  event.respondWith(networkFirst(request, true));
});
