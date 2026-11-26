import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sqlite } from "@/db";

/** A malformed or missing credential. The message names the exact env var/file to fix. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** A write raced another device/process, or setup was attempted a second time. Maps to HTTP 409. */
export class CredentialConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialConflictError";
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

/**
 * UNCONFIGURED: no env credentials and no stored credentials — setup must be completed in the UI.
 * LEGACY: env credentials are the only ones present and remain authoritative.
 * STORED: persisted credentials exist and take precedence over env credentials from now on.
 */
export type AuthState = "unconfigured" | "legacy" | "stored";

export type StoredCredentials = Readonly<{
  active: boolean;
  passwordHash: string;
  sessionSecret: string;
  /** Settings-managed agent bearer token. Null means fall back to the env/token-file token. */
  agentToken: string | null;
  createdAtMs: number;
  updatedAtMs: number;
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

/** Fresh HMAC key for a persisted credential set. Hex, 64 chars — well above the 32-char floor. */
export function newSessionSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Non-secret timing knobs come from env; the agent token prefers the stored value, else env. */
function sessionDays(): number {
  const daysRaw = process.env.HEALTHVAULT_SESSION_DAYS?.trim();
  const days = daysRaw ? Number(daysRaw) : DEFAULT_SESSION_DAYS;
  if (!Number.isInteger(days) || days < 1) {
    throw new AuthConfigError("HEALTHVAULT_SESSION_DAYS must be a positive integer");
  }
  return days;
}

function cookieSecure(): boolean {
  return process.env.HEALTHVAULT_COOKIE_SECURE === "1";
}

/**
 * Build a config from a raw hash + secret (used for stored credentials). When `agentToken` is
 * supplied (the stored, settings-managed value) it wins; a null/undefined value keeps the legacy
 * env/token-file behaviour. Never cache this — the stored row is re-read on every request.
 */
export function buildConfig(rawHash: string, secret: string, agentToken?: string | null): AuthConfig {
  if (secret.length < 32) {
    throw new AuthConfigError("Session secret must be at least 32 characters");
  }
  return Object.freeze({
    passwordHash: parsePasswordHash(rawHash),
    sessionSecret: secret,
    agentToken: agentToken ?? loadAgentToken(),
    sessionDays: sessionDays(),
    cookieSecure: cookieSecure(),
  });
}

/** Strict loader for env credentials. Throws AuthConfigError with an actionable message. */
function loadEnvConfig(): AuthConfig {
  const rawHash = process.env.HEALTHVAULT_PASSWORD_HASH?.trim();
  if (!rawHash) {
    throw new AuthConfigError(
      `HEALTHVAULT_PASSWORD_HASH is required; expected ${PASSWORD_HASH_FORMAT}`,
    );
  }
  const passwordHash = parsePasswordHash(rawHash);

  const secret = process.env.HEALTHVAULT_SESSION_SECRET ?? "";
  if (secret.length < 32) {
    throw new AuthConfigError(
      "HEALTHVAULT_SESSION_SECRET is required and must be at least 32 characters",
    );
  }

  return Object.freeze({
    passwordHash,
    sessionSecret: secret,
    agentToken: loadAgentToken(),
    sessionDays: sessionDays(),
    cookieSecure: cookieSecure(),
  });
}

/** True only when neither env credential was supplied. A partial set still fails fast below. */
function envCredentialsAbsent(): boolean {
  const rawHash = process.env.HEALTHVAULT_PASSWORD_HASH?.trim();
  const secret = process.env.HEALTHVAULT_SESSION_SECRET?.trim();
  return !rawHash && !secret;
}

let cachedEnvConfig: AuthConfig | undefined;

/** Env config is process-constant; cached. Never cache the DB-backed part — see getActiveAuthConfig. */
function getEnvConfig(): AuthConfig | null {
  if (envCredentialsAbsent()) return null;
  if (cachedEnvConfig === undefined) cachedEnvConfig = loadEnvConfig();
  return cachedEnvConfig;
}

/** Test/admin helper: re-read env after changing process.env in one process. */
export function invalidateEnvConfigCache(): void {
  cachedEnvConfig = undefined;
}

export function hasEnvCredentials(): boolean {
  return !envCredentialsAbsent();
}

/* ---------------------------------------------------------------------------------------------
 * Stored credentials (singleton id = 1)
 * ------------------------------------------------------------------------------------------- */

export function getStoredCredentials(): StoredCredentials | null {
  const row = sqlite
    .prepare(
      `SELECT password_hash, session_secret, agent_token, active, created_at_ms, updated_at_ms
         FROM auth_credentials WHERE id = 1`,
    )
    .get() as
    | {
        password_hash: string;
        session_secret: string;
        agent_token: string | null;
        active: number;
        created_at_ms: number;
        updated_at_ms: number;
      }
    | undefined;
  if (!row) return null;
  return {
    active: row.active === 1,
    passwordHash: row.password_hash,
    sessionSecret: row.session_secret,
    agentToken: row.agent_token,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * Persist credentials with compare-and-swap semantics inside one transaction:
 * - `setup` writes only when there is no active row, so a second/concurrent first-run cannot win.
 * - `change` writes only when the active row is still at the revision the caller confirmed, and
 *   migrates a LEGACY env install by creating the active row the first time.
 */
export function persistStoredCredentials(
  mode: "setup",
  input: { passwordHash: string; sessionSecret: string },
): StoredCredentials;
export function persistStoredCredentials(
  mode: "change",
  input: { passwordHash: string; sessionSecret: string; expectedUpdatedAtMs: number },
): StoredCredentials;
export function persistStoredCredentials(
  mode: "setup" | "change",
  input: { passwordHash: string; sessionSecret: string; expectedUpdatedAtMs?: number },
): StoredCredentials {
  const { passwordHash, sessionSecret } = input;
  const now = Date.now();
  return sqlite.transaction(() => {
    const current = getStoredCredentials();

    if (mode === "setup" && current?.active) {
      throw new CredentialConflictError(
        "HealthVault is already set up; the first password cannot be initialized again",
      );
    }
    if (mode === "change" && current?.active && current.updatedAtMs !== input.expectedUpdatedAtMs) {
      throw new CredentialConflictError(
        "Credentials changed on another device; reload and try again",
      );
    }

    // CAS on the row's current active flag + timestamp, whatever it is. Setup expects an inactive
    // row; a password change expects the active revision the caller confirmed (or an inactive row
    // when migrating a legacy install that never ran setup).
    const expected =
      current && (mode === "setup" || !current.active)
        ? current.updatedAtMs
        : input.expectedUpdatedAtMs;
    if (current) {
      const result = sqlite
        .prepare(
          `UPDATE auth_credentials SET password_hash = ?, session_secret = ?, active = 1,
              updated_at_ms = ?
            WHERE id = 1 AND active = ? AND updated_at_ms = ?`,
        )
        .run(passwordHash, sessionSecret, now, current.active ? 1 : 0, expected ?? current.updatedAtMs);
      if (result.changes !== 1) {
        throw new CredentialConflictError("Credentials changed concurrently; try again");
      }
    } else {
      const result = sqlite
        .prepare(
          `INSERT INTO auth_credentials
             (id, password_hash, session_secret, active, created_at_ms, updated_at_ms)
           VALUES (1, ?, ?, 1, ?, ?)`,
        )
        .run(passwordHash, sessionSecret, now, now);
      if (result.changes !== 1) {
        throw new CredentialConflictError("Credentials changed concurrently; try again");
      }
    }
    return getStoredCredentials()!;
  }).immediate();
}

/**
 * Store (or rotate) the settings-managed agent token with compare-and-swap semantics. The CAS is
 * on the active row's `updated_at_ms`, the same revision password changes use, so a concurrent
 * rotation or password change is rejected instead of silently overwriting a newer token. Bumping
 * the revision also makes the previous token stop resolving on the very next request.
 */
export function storeAgentToken(
  agentToken: string,
  expectedUpdatedAtMs: number,
): StoredCredentials {
  // Strictly advance the revision even inside one millisecond, otherwise two rapid rotations could
  // share a timestamp and the loser's stale CAS would wrongly succeed.
  const now = Math.max(Date.now(), expectedUpdatedAtMs + 1);
  return sqlite.transaction(() => {
    const current = getStoredCredentials();
    if (!current?.active || current.updatedAtMs !== expectedUpdatedAtMs) {
      throw new CredentialConflictError(
        "Token changed on another device; reload and try again",
      );
    }
    const result = sqlite
      .prepare(
        `UPDATE auth_credentials SET agent_token = ?, updated_at_ms = ?
           WHERE id = 1 AND active = 1 AND updated_at_ms = ?`,
      )
      .run(agentToken, now, expectedUpdatedAtMs);
    if (result.changes !== 1) {
      throw new CredentialConflictError("Token changed concurrently; try again");
    }
    return getStoredCredentials()!;
  }).immediate();
}

/* ---------------------------------------------------------------------------------------------
 * Active credential resolution. Precedence is deterministic:
 *   active stored credentials → LEGACY env credentials → UNCONFIGURED.
 * Stored wins even when env credentials remain set, so setup/password-change closes the env path
 * without ever resetting an existing password or health data.
 * ------------------------------------------------------------------------------------------- */

export function getAuthState(): AuthState {
  if (getStoredCredentials()?.active) return "stored";
  const env = getEnvConfig(); // throws on a partial/malformed env setup — fail fast, no setup bypass
  return env ? "legacy" : "unconfigured";
}

export function isUnconfigured(): boolean {
  return getAuthState() === "unconfigured";
}

/**
 * The config every request uses. The stored row is read on every call — a process-wide cache
 * would go stale in a separate bundle (proxy vs route handler) and reject the renewed cookie
 * after a password change. The singleton SELECT is negligible next to scrypt/HMAC work.
 */
export function getActiveAuthConfig(): AuthConfig {
  const stored = getStoredCredentials();
  // A stored token wins; null keeps the env/token-file fallback for existing installs.
  if (stored?.active) return buildConfig(stored.passwordHash, stored.sessionSecret, stored.agentToken);
  const env = getEnvConfig();
  if (env) return env;
  throw new AuthConfigError(
    "HealthVault setup is required: no credentials are configured. Open /setup to create the first password.",
  );
}

/** Back-compat name used by instrumentation and existing tests. */
export const getAuthConfig = getActiveAuthConfig;
