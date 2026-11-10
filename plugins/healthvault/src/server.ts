/**
 * Thin HTTP client for the HealthVault agent API.
 *
 * The MCP server never touches SQLite directly: every tool goes through
 * `POST /api/agent/<tool>`, the same service layer the web UI uses. Every
 * request carries the shared bearer token the app requires.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:3040";
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Default token file, kept tilde-form so error messages stay readable. */
export const DEFAULT_TOKEN_FILE = "~/.config/healthvault/token";

const START_HINT = "systemctl --user start healthvault";
const STATUS_HINT = "systemctl --user status healthvault";

export interface ServerOptions {
  /** Base URL of the running app. Defaults to `HEALTHVAULT_URL` or `http://127.0.0.1:3040`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to `HEALTHVAULT_TIMEOUT_MS` or 15000. */
  timeoutMs?: number;
  /**
   * Bearer token, or a provider read on every request so a freshly written token
   * file is picked up without restarting the client. When omitted, the token is
   * resolved from `HEALTHVAULT_TOKEN` and then `HEALTHVAULT_TOKEN_FILE`.
   */
  token?: string | null | (() => string | undefined);
  /** Injectable fetch, mainly for tests. */
  fetchImpl?: typeof fetch;
}

export class HealthVaultError extends Error {
  readonly status: number | undefined;
  readonly tool: string | undefined;
  readonly reason: unknown;

  constructor(
    message: string,
    options: { status?: number; tool?: string; reason?: unknown } = {},
  ) {
    super(message);
    this.name = "HealthVaultError";
    this.status = options.status;
    this.tool = options.tool;
    this.reason = options.reason;
  }
}

export interface HealthVaultServer {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  request<T>(tool: string, body?: unknown, signal?: AbortSignal): Promise<T>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function resolveBaseUrl(baseUrl?: string): string {
  const configured =
    nonEmptyString(baseUrl) ?? nonEmptyString(process.env.HEALTHVAULT_URL) ?? DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, "");
}

export function resolveTimeoutMs(timeoutMs?: number): number {
  return (
    positiveNumber(timeoutMs) ??
    positiveNumber(process.env.HEALTHVAULT_TIMEOUT_MS) ??
    DEFAULT_TIMEOUT_MS
  );
}

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** The token file path, as configured, with `~` expanded for file reads. */
export function resolveTokenFile(): string {
  return expandHome(nonEmptyString(process.env.HEALTHVAULT_TOKEN_FILE) ?? DEFAULT_TOKEN_FILE);
}

/**
 * Token resolution order: `HEALTHVAULT_TOKEN`, then the token file
 * (`HEALTHVAULT_TOKEN_FILE`, default `~/.config/healthvault/token`), trimmed.
 * Returns undefined when neither is available; the caller fails the tool call
 * with an actionable message instead of crashing at startup.
 */
export function resolveToken(): string | undefined {
  const fromEnv = nonEmptyString(process.env.HEALTHVAULT_TOKEN);
  if (fromEnv) return fromEnv;

  try {
    const fromFile = readFileSync(resolveTokenFile(), "utf8").trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}

/** The path shown in error messages, kept in tilde-form when it is the default. */
function displayTokenFile(): string {
  return nonEmptyString(process.env.HEALTHVAULT_TOKEN_FILE) ?? DEFAULT_TOKEN_FILE;
}

export function missingTokenMessage(): string {
  return (
    `HealthVault bearer token is not set — write it to ${displayTokenFile()} (chmod 600) ` +
    `or set HEALTHVAULT_TOKEN, then restart the MCP client.`
  );
}

function tokenRejectedMessage(tool: string, status: number): string {
  return (
    `HealthVault tool "${tool}" failed (${status}): bearer token rejected — ` +
    `check the token file (${displayTokenFile()}) or HEALTHVAULT_TOKEN, ` +
    `then restart the MCP client.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown, text: string): string | undefined {
  if (isRecord(payload) && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }
  const fallback = text.trim();
  if (!fallback) return undefined;
  // An HTML error page means the request never reached the agent route (wrong port, old
  // build, proxy). Do not dump a whole document into a tool result.
  if (fallback.startsWith("<")) return "unexpected HTML response instead of JSON — check that the service is the HealthVault build";
  return fallback.slice(0, 500);
}

function tokenSource(option: ServerOptions["token"]): () => string | undefined {
  if (typeof option === "function") return option;
  if (typeof option === "string") {
    const token = nonEmptyString(option);
    return () => token;
  }
  return resolveToken;
}

export function createServer(options: ServerOptions = {}): HealthVaultServer {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const doFetch = options.fetchImpl ?? fetch;
  const getToken = tokenSource(options.token);

  async function request<T>(tool: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    const url = `${baseUrl}/api/agent/${encodeURIComponent(tool)}`;
    const token = getToken();
    if (!token) {
      throw new HealthVaultError(missingTokenMessage(), { tool });
    }

    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      const text = await response.text();
      const payload = parsePayload(text);

      if (response.status === 401 || response.status === 403) {
        throw new HealthVaultError(tokenRejectedMessage(tool, response.status), {
          status: response.status,
          tool,
        });
      }

      if (!response.ok) {
        const message =
          errorMessage(payload, text) || response.statusText || "request failed";
        throw new HealthVaultError(
          `HealthVault tool "${tool}" failed (${response.status}): ${message}`,
          { status: response.status, tool },
        );
      }

      if (!isRecord(payload) || payload.ok !== true) {
        const message =
          errorMessage(payload, text) ||
          "the response did not contain { ok: true, result }";
        throw new HealthVaultError(
          `HealthVault tool "${tool}" returned an error: ${message}`,
          { tool },
        );
      }

      return payload.result as T;
    } catch (error) {
      if (error instanceof HealthVaultError) throw error;
      // The caller cancelled the tool call; do not disguise it as a service failure.
      if (signal?.aborted) throw error;

      if (timedOut) {
        throw new HealthVaultError(
          `HealthVault did not respond within ${timeoutMs} ms at ${baseUrl}. ` +
            `Check the service with "${STATUS_HINT}" and start it with "${START_HINT}".`,
          { tool, reason: error },
        );
      }

      throw new HealthVaultError(
        `HealthVault service is not reachable at ${baseUrl} — start it with: ${START_HINT} ` +
          `(check it with "${STATUS_HINT}").`,
        { tool, reason: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  return { baseUrl, timeoutMs, request };
}
