import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { PasswordHash } from "@/lib/auth-config";
import {
  PASSWORD_HASH_KEY_BYTES,
  PASSWORD_HASH_PARAMS,
  PASSWORD_HASH_SALT_BYTES,
  getAuthConfig,
  parsePasswordHash,
} from "@/lib/auth-config";

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

function matchesPasswordHash(password: string, passwordHash: PasswordHash): boolean {
  const derived = scryptSync(password, passwordHash.salt, passwordHash.hash.length, {
    N: passwordHash.N,
    r: passwordHash.r,
    p: passwordHash.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return derived.length === passwordHash.hash.length && timingSafeEqual(derived, passwordHash.hash);
}

export function verifyPassword(password: string): boolean {
  return matchesPasswordHash(password, getAuthConfig().passwordHash);
}

/**
 * Hash a new password with the canonical scrypt parameters and output the exact
 * `scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>` string that auth-config parses.
 */
export function hashPassword(password: string): string {
  const { N, r, p } = PASSWORD_HASH_PARAMS;
  const salt = randomBytes(PASSWORD_HASH_SALT_BYTES);
  const hash = scryptSync(password, salt, PASSWORD_HASH_KEY_BYTES, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${N}:${r}:${p}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a password against a raw hash string without loading auth config, so it
 * works when the session secret is absent (e.g. the password CLI).
 * A malformed hash simply does not match.
 */
export function verifyPasswordHash(password: string, rawHash: string): boolean {
  try {
    return matchesPasswordHash(password, parsePasswordHash(rawHash));
  } catch {
    return false;
  }
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
