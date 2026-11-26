import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // Proxy (src/proxy.ts) runs on every request, so Next buffers each request body to let the
    // proxy and the route handler both read it. The default cap is 10 MB, and a body over it is
    // silently truncated rather than rejected — a real Export.zip is ~20 MB, so `req.formData()`
    // in POST /api/upload saw a cut-off multipart stream and answered 400. Leave headroom above
    // the route's own 200 MB zip cap for the multipart envelope.
    proxyClientMaxBodySize: "220mb",
  },
  // Next 16 blocks dev resources for origins it doesn't know; the smoke tests and
  // browser checks hit 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.31.10", "100.67.153.70"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // The app is single-user and LAN-bound: keep it out of indexes and out of frames,
          // and do not let the browser sniff content types.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
