import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A malformed or missing credential. The message names the exact env var/file to fix. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export type PasswordHash = Readonly<{
  /** scrypt CPU/memory cost. */
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}>;

export type AuthConfig = Readonly<{
  passwordHash: PasswordHash;
  sessionSecret: string;
  agentToken: string | null;
  sessionDays: number;
  cookieSecure: boolean;
}>;

const DEFAULT_SESSION_DAYS = 30;
export const PASSWORD_HASH_FORMAT = "scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>";
/** Canonical scrypt parameters. Password hashing and verification both read them from here. */
export const PASSWORD_HASH_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
export const PASSWORD_HASH_SALT_BYTES = 16;
export const PASSWORD_HASH_KEY_BYTES = 32;

function loadAgentToken(): string | null {
  const token = process.env.HEALTHVAULT_API_TOKEN?.trim();
  const tokenFile = process.env.HEALTHVAULT_API_TOKEN_FILE?.trim();
  if (token && tokenFile) {
    throw new AuthConfigError("Set only one of HEALTHVAULT_API_TOKEN or HEALTHVAULT_API_TOKEN_FILE");
  }

  let value = token || null;
  if (tokenFile) {
    const path = expandHomePath(tokenFile);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new AuthConfigError("HEALTHVAULT_API_TOKEN_FILE must be a regular owner-only file (mode 0600)");
      }
      value = readFileSync(path, "utf8").trim();
    } catch (error) {
      if (error instanceof AuthConfigError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new AuthConfigError(
        code === "ENOENT"
          ? `HEALTHVAULT_API_TOKEN_FILE does not exist: ${path}`
          : `HEALTHVAULT_API_TOKEN_FILE could not be read: ${path}`,
      );
    }
  }

  if (value !== null && value.length < 32) {
    throw new AuthConfigError("HEALTHVAULT_API_TOKEN must be at least 32 characters");
  }
  return value;
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function parsePasswordHash(raw: string): PasswordHash {
  const parts = raw.trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    throw new AuthConfigError(
      `HEALTHVAULT_PASSWORD_HASH is malformed; expected ${PASSWORD_HASH_FORMAT}`,
    );
  }

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    p < 1
  ) {
    throw new AuthConfigError(
      `HEALTHVAULT_PASSWORD_HASH has invalid scrypt parameters; expected ${PASSWORD_HASH_FORMAT}`,
    );
  }

  if (!/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length % 2 !== 0) {
    throw new AuthConfigError("HEALTHVAULT_PASSWORD_HASH salt must be hex-encoded");
  }
  if (!/^[0-9a-fA-F]+$/.test(hashHex) || hashHex.length !== 64) {
    throw new AuthConfigError(
      "HEALTHVAULT_PASSWORD_HASH hash must be a 32-byte (64-character) hex digest",
    );
  }

  return Object.freeze({
    N,
    r,
    p,
    salt: Buffer.from(saltHex, "hex"),
    hash: Buffer.from(hashHex, "hex"),
  });
}

function loadAuthConfig(): AuthConfig {
  const rawHash = process.env.HEALTHVAULT_PASSWORD_HASH?.trim();
  if (!rawHash) {
    throw new AuthConfigError(
      `HEALTHVAULT_PASSWORD_HASH is required; expected ${PASSWORD_HASH_FORMAT}`,
    );
  }
  const passwordHash = parsePasswordHash(rawHash);

  const sessionSecret = process.env.HEALTHVAULT_SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) {
    throw new AuthConfigError(
      "HEALTHVAULT_SESSION_SECRET is required and must be at least 32 characters",
    );
  }

  const daysRaw = process.env.HEALTHVAULT_SESSION_DAYS?.trim();
  const sessionDays = daysRaw ? Number(daysRaw) : DEFAULT_SESSION_DAYS;
  if (!Number.isInteger(sessionDays) || sessionDays < 1) {
    throw new AuthConfigError("HEALTHVAULT_SESSION_DAYS must be a positive integer");
  }

  return Object.freeze({
    passwordHash,
    sessionSecret,
    agentToken: loadAgentToken(),
    sessionDays,
    cookieSecure: process.env.HEALTHVAULT_COOKIE_SECURE === "1",
  });
}

let cached: AuthConfig | undefined;

/**
 * Load and validate every credential. Called once at boot by instrumentation.ts, then reused
 * per request. Throws AuthConfigError with an actionable message; there is no auth-off mode.
 */
export function getAuthConfig(): AuthConfig {
  if (!cached) cached = loadAuthConfig();
  return cached;
}
