/**
 * Settings-managed agent (harness) bearer token.
 *
 * The single-user app already has one agent token, historically read from the environment or a
 * private token file. This service makes that token visible and rotatable from Settings while
 * keeping the env/token-file fallback for installs that have not generated one yet. It never logs
 * the token value, and rotation invalidates the previous token on the very next request.
 */
import { randomBytes } from "node:crypto";
import {
  AuthConfigError,
  CredentialConflictError,
  getActiveAuthConfig,
  getAuthState,
  getStoredCredentials,
  persistStoredCredentials,
  storeAgentToken,
} from "@/lib/auth-config";

export type AgentTokenState = Readonly<{
  token: string | null;
  source: "stored" | "env" | null;
}>;

/** Read the currently effective token and where it came from — without ever logging its value. */
export function getAgentTokenState(): AgentTokenState {
  const stored = getStoredCredentials();
  if (stored?.active && stored.agentToken) {
    return { token: stored.agentToken, source: "stored" };
  }
  const token = getActiveAuthConfig().agentToken;
  return { token: token ?? null, source: token ? "env" : null };
}

/**
 * Generate a fresh 64-hex-character token (32 random bytes, same shape as the bootstrap secret)
 * and make it the active agent token. A stored token wins over the env token from this moment on,
 * so the previous value stops resolving immediately. The CAS in `storeAgentToken` rejects a
 * concurrent rotation or password change with a 409-mapped conflict error.
 */
export function rotateAgentToken(): { token: string; source: "stored" } {
  const token = randomBytes(32).toString("hex");
  let stored = getStoredCredentials();

  if (!stored?.active) {
    // LEGACY install: migrate the env credentials verbatim first, so the existing password and
    // signed-in sessions keep working, then store the token. A concurrent first rotation loses
    // the setup CAS below and is reported as a conflict.
    if (getAuthState() !== "legacy") {
      throw new AuthConfigError(
        "HealthVault must be set up before a harness token can be generated",
      );
    }
    const rawHash = process.env.HEALTHVAULT_PASSWORD_HASH?.trim();
    const secret = process.env.HEALTHVAULT_SESSION_SECRET;
    if (!rawHash || !secret || secret.length < 32) {
      throw new AuthConfigError(
        "Legacy credentials are incomplete; fix HEALTHVAULT_PASSWORD_HASH and HEALTHVAULT_SESSION_SECRET",
      );
    }
    try {
      persistStoredCredentials("setup", { passwordHash: rawHash, sessionSecret: secret });
    } catch (error) {
      if (error instanceof CredentialConflictError) {
        // Another device migrated/rotated first — tell the caller to reload rather than clobber.
        throw new CredentialConflictError("Token changed on another device; reload and try again");
      }
      throw error;
    }
    stored = getStoredCredentials();
  }

  if (!stored?.active) {
    throw new CredentialConflictError("Credentials changed concurrently; try again");
  }
  storeAgentToken(token, stored.updatedAtMs);
  return { token, source: "stored" };
}
