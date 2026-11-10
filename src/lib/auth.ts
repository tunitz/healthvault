import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { getAuthConfig } from "@/lib/auth-config";

export const SESSION_COOKIE = "hv_session";

/** scrypt needs headroom for N/r/p; 256 MB comfortably covers the documented N=16384,r=8,p=1. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

/** Thrown when a server action or route runs without a valid session. */
export class AuthenticationError extends Error {
  constructor(message = "Not signed in — sign in again") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function verifyPassword(password: string): boolean {
  const { passwordHash } = getAuthConfig();
  const derived = scryptSync(password, passwordHash.salt, passwordHash.hash.length, {
    N: passwordHash.N,
    r: passwordHash.r,
    p: passwordHash.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(derived, passwordHash.hash);
}

function sessionMac(expires: string, secret: string): string {
  return createHmac("sha256", secret).update(expires).digest("hex");
}

/** Cookie value: v1.<expEpochSeconds>.<hmacSha256HexOfExp> */
export function signSession(nowMs = Date.now()): string {
  const expires = Math.floor(nowMs / 1000) + getAuthConfig().sessionDays * 86_400;
  return `v1.${expires}.${sessionMac(String(expires), getAuthConfig().sessionSecret)}`;
}

export function verifySession(value: string | null | undefined, nowMs = Date.now()): boolean {
  if (!value) return false;

  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;

  const [, expiresRaw, macHex] = parts;
  if (!/^\d+$/.test(expiresRaw) || !/^[0-9a-fA-F]{64}$/.test(macHex)) return false;

  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(nowMs / 1000)) return false;

  const expected = Buffer.from(sessionMac(expiresRaw, getAuthConfig().sessionSecret), "hex");
  const actual = Buffer.from(macHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sessionCookieOptions() {
  const { sessionDays, cookieSecure } = getAuthConfig();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: cookieSecure,
    maxAge: sessionDays * 86_400,
  };
}

export function expiredSessionCookieOptions() {
  const { cookieSecure } = getAuthConfig();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: cookieSecure,
    maxAge: 0,
  };
}

export function verifyBearerToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(getAuthConfig().apiToken);
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Agent/API-token guard. Bearer only — cookie auth is deliberately not accepted for
 * /api/agent/*, which keeps the agent surface free of CSRF.
 */
export function requireToken(request: Request): Response | null {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;

  if (!header) {
    return Response.json(
      {
        error:
          "missing bearer token; MCP clients read " + getAuthConfig().apiTokenSource,
      },
      { status: 401 },
    );
  }
  if (!token || !verifyBearerToken(token)) {
    return Response.json(
      {
        error:
          "invalid bearer token; MCP clients read " + getAuthConfig().apiTokenSource,
      },
      { status: 401 },
    );
  }
  return null;
}

/** For server actions and routes that want to throw on missing auth. */
export async function requireSession(): Promise<void> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  if (!verifySession(store.get(SESSION_COOKIE)?.value)) {
    throw new AuthenticationError();
  }
}

/** For route handlers: returns a ready 401 response, or null when authenticated. */
export async function requireSessionOr401(): Promise<Response | null> {
  try {
    await requireSession();
    return null;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return Response.json({ error: "authentication required" }, { status: 401 });
    }
    throw error;
  }
}

/* ---------------------------------------------------------------------------------------------
 * Login throttling
 * A single process-wide counter, matching the single-user model: 5 failures per 15 minutes.
 * ------------------------------------------------------------------------------------------- */

type LoginWindow = { failures: number; resetAt: number };

let loginWindow: LoginWindow = { failures: 0, resetAt: 0 };

function currentWindow(now: number): LoginWindow {
  if (now >= loginWindow.resetAt) loginWindow = { failures: 0, resetAt: now + LOGIN_WINDOW_MS };
  return loginWindow;
}

export function loginThrottled(nowMs = Date.now()): boolean {
  return currentWindow(nowMs).failures >= MAX_LOGIN_FAILURES;
}

export function recordLoginFailure(nowMs = Date.now()): void {
  const window = currentWindow(nowMs);
  window.failures += 1;
  // Never log the password or any secret.
  console.error(
    `[auth] failed login attempt ${window.failures}/${MAX_LOGIN_FAILURES} at ${new Date(nowMs).toISOString()}`,
  );
}

export function clearLoginFailures(): void {
  loginWindow = { failures: 0, resetAt: 0 };
}
