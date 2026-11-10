import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

/**
 * Pages and endpoints reachable without a session. Everything else needs a valid hv_session
 * cookie. /api/agent/* is intentionally NOT here: it is a bearer-only surface and its route
 * handlers call requireToken() themselves.
 */
const PUBLIC_EXACT = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/health",
  "/sw.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/logo-mark.svg",
  "/icon.svg",
  "/apple-icon.png",
  "/favicon.ico",
  "/favicon.png",
]);

const STATIC_FILE = /\.(?:png|svg|ico|webp|jpg|jpeg|gif|txt|xml|webmanifest)$/i;

function isPublic(path: string): boolean {
  if (PUBLIC_EXACT.has(path)) return true;
  if (path.startsWith("/_next/")) return true;
  // Never let a file extension exempt an API route from session/token auth.
  if (path.startsWith("/api/")) return false;
  return STATIC_FILE.test(path);
}

function isAgentPath(path: string): boolean {
  return path === "/api/agent" || path.startsWith("/api/agent/");
}

/**
 * Report-only CSP. The request-side Content-Security-Policy header is what lets Next.js attach
 * the nonce to its own scripts during server rendering; the browser only ever receives the
 * Report-Only header, so a policy mismatch cannot break the app while it is being tuned.
 */
function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    // recharts and the chart primitives set inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function withPolicy(response: NextResponse, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy-Report-Only", csp);
  return response;
}

function nextWithHeaders(request: NextRequest, requestHeaders: Headers, csp: string): NextResponse {
  return withPolicy(NextResponse.next({ request: { headers: requestHeaders } }), csp);
}

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Consumed by Next.js for nonce injection; the browser only sees the Report-Only response.
  requestHeaders.set("Content-Security-Policy", csp);

  const { pathname, search } = request.nextUrl;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;

  // Authenticated by token in the route itself — never demand a cookie here.
  if (isAgentPath(path)) {
    return nextWithHeaders(request, requestHeaders, csp);
  }

  if (isPublic(path)) {
    return nextWithHeaders(request, requestHeaders, csp);
  }

  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (verifySession(session)) {
    const response = nextWithHeaders(request, requestHeaders, csp);
    // Authenticated HTML/API responses are per-session and must not be cached.
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie");
    return response;
  }

  if (path.startsWith("/api/")) {
    return withPolicy(
      NextResponse.json({ error: "authentication required" }, { status: 401 }),
      csp,
    );
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return withPolicy(NextResponse.redirect(loginUrl), csp);
}
