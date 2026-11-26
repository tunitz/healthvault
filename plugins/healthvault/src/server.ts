import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thin HTTP client for the HealthVault agent API.
 *
 * The MCP server never touches SQLite directly: every tool goes through
 * `POST /api/agent/<tool>`, the same service layer the web UI uses. The agent
 * machine API accepts a bearer token; base URL and timeout are client options,
 * while the token comes from the process environment or a private file.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:3040";
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Host-agnostic startup hint: the app may run under any supervisor or bare shell. */
const START_HINT = "`bun run start` in the HealthVault project directory";

export interface ServerOptions {
  /** Base URL of the running app. Defaults to `HEALTHVAULT_URL` or `http://127.0.0.1:3040`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to `HEALTHVAULT_TIMEOUT_MS` or 15000. */
  timeoutMs?: number;
  /** Injectable fetch, mainly for tests and the in-app transport. */
  fetchImpl?: typeof fetch;
  /** Explicit bearer token. When omitted, resolves from env/token file. The in-app Streamable
   * HTTP transport dispatches locally and supplies a non-secret placeholder; no file is read. */
  token?: string;
}

function configuredToken(): string {
  const token = nonEmptyString(process.env.HEALTHVAULT_TOKEN);
  const tokenFile = nonEmptyString(process.env.HEALTHVAULT_TOKEN_FILE);
  if (token && tokenFile) {
    throw new Error("Set only one of HEALTHVAULT_TOKEN or HEALTHVAULT_TOKEN_FILE");
  }
  if (token) {
    if (token.length < 32) throw new Error("HEALTHVAULT_TOKEN must be at least 32 characters");
    return token;
  }
  if (!tokenFile) throw new Error("Set HEALTHVAULT_TOKEN or HEALTHVAULT_TOKEN_FILE for the MCP client");

  const path = tokenFile === "~"
    ? homedir()
    : tokenFile.startsWith("~/")
      ? join(homedir(), tokenFile.slice(2))
      : tokenFile;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("HEALTHVAULT_TOKEN_FILE must be a regular owner-only file (mode 0600)");
    }
    const value = readFileSync(path, "utf8").trim();
    if (value.length < 32) {
      throw new Error("HEALTHVAULT_TOKEN_FILE must contain a token of at least 32 characters");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("HEALTHVAULT_TOKEN_FILE")) throw error;
    throw new Error(`HEALTHVAULT_TOKEN_FILE could not be read: ${path}`);
  }
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

export function createServer(options: ServerOptions = {}): HealthVaultServer {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const doFetch = options.fetchImpl ?? fetch;
  const token = options.token ?? configuredToken();

  async function request<T>(tool: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    const url = `${baseUrl}/api/agent/${encodeURIComponent(tool)}`;

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
            `Check the service (GET /api/health) and start it with: ${START_HINT}.`,
          { tool, reason: error },
        );
      }

      throw new HealthVaultError(
        `HealthVault service is not reachable at ${baseUrl} — start it with: ${START_HINT} ` +
          `(check it with GET /api/health).`,
        { tool, reason: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  return { baseUrl, timeoutMs, request };
}
