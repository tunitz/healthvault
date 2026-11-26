import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, agentRequestFailure, verifySession } from "@/lib/auth";
import { isUnconfigured } from "@/lib/auth-config";
import { mcpAccessFailure } from "@/lib/services/mcp";

/**
 * Pages and endpoints reachable without a session. Everything else needs a valid hv_session
 * cookie. The agent surface has its own bearer-token/session and Host/Origin gate below.
 */
const PUBLIC_EXACT = new Set([
  "/login",
  "/setup",
  "/api/auth/setup",
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
  // Never let a file extension exempt an API route from session auth.
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

  // Static assets, icons, the service worker and the manifest never depend on setup state — skip
  // the credential lookup (which reads the singleton DB row) for them.
  if (path.startsWith("/_next/") || (!path.startsWith("/api/") && STATIC_FILE.test(path))) {
    return nextWithHeaders(request, requestHeaders, csp);
  }

  const unconfigured = isUnconfigured();
  if (unconfigured) {
    // Health probe, the setup page/endpoint and the login page (which renders the setup form)
    // stay reachable. Every other API answers 503; every other page goes to setup.
    if (path === "/api/health" || path === "/setup" || path === "/api/auth/setup" || path === "/login") {
      return nextWithHeaders(request, requestHeaders, csp);
    }
    if (path.startsWith("/api/")) {
      return withPolicy(
        NextResponse.json(
          { error: "setup required: create the first password at /setup", setupRequired: true },
          { status: 503 },
        ),
        csp,
      );
    }
    return withPolicy(NextResponse.redirect(new URL("/setup", request.url)), csp);
  }

  // Setup is permanently closed once credentials exist (env legacy or stored).
  if (path === "/setup") {
    return withPolicy(NextResponse.redirect(new URL("/", request.url)), csp);
  }

  // Machine access: the agent API and the direct Streamable HTTP MCP endpoint both require the
  // session/bearer + Host/Origin gate and the real MCP enable/LAN gate. The UI-only
  // /api/mcp/status endpoint deliberately falls through to the normal session gate below so the
  // settings page can still report "disabled" while machine access is off.
  if (isAgentPath(path) || path === "/api/mcp") {
    const failure = agentRequestFailure(request);
    if (failure) {
      return withPolicy(NextResponse.json({ error: failure.error }, { status: failure.status }), csp);
    }
    const access = mcpAccessFailure(request);
    if (access) {
      return withPolicy(NextResponse.json({ error: access.error }, { status: access.status }), csp);
    }
    const response = nextWithHeaders(request, requestHeaders, csp);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie, Authorization, Origin");
    return response;
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
