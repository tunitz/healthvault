// Health Vault service worker: read-only offline cache.
// Bump VERSION whenever cache layout or caching rules change.
const VERSION = "v1";
const CACHE = `healthvault-${VERSION}`;
const NETWORK_TIMEOUT_MS = 4000;
const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Health Vault (offline)</title>
<style>
  html,body{margin:0;height:100%;font-family:system-ui,-apple-system,sans-serif;background:#f7f8fa;color:#16181c}
  @media (prefers-color-scheme:dark){html,body{background:#16181c;color:#e6e8ec}}
  main{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center}
  p{color:#6b7280;font-size:14px}
</style></head>
<body><main><h1 style="font-size:20px;margin:0 0 8px">Offline and nothing cached yet</h1>
<p>Connect to the network once to load this page. Pages you have viewed will be available offline.</p></main></body></html>`;

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

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.status === 200) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request, isNavigation) {
  const cache = await caches.open(CACHE);

  const network = fetch(request).then((response) => {
    if (response.ok && response.status === 200) {
      cache.put(request, response.clone()).catch(() => {});
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
  } catch (_) {
    // network error: fall through to cache
  } finally {
    clearTimeout(timer);
  }

  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;

  if (isNavigation) {
    const home = await cache.match("/", { ignoreVary: true });
    if (home) return home;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Non-navigation with nothing cached: let the original failure surface.
  try {
    return await network;
  } catch (_) {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/upload")) return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  const isNavigation = request.mode === "navigate";
  event.respondWith(networkFirst(request, isNavigation));
});
