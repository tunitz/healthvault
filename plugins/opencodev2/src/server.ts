/**
 * Thin HTTP client for the HealthVault agent API.
 *
 * The OpenCode plugin never touches SQLite directly: every tool goes through
 * `POST /api/agent/<tool>`, the same service layer the web UI uses.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:3040";
export const DEFAULT_TIMEOUT_MS = 15_000;

const START_HINT = "systemctl --user start healthvault";
const STATUS_HINT = "systemctl --user status healthvault";

export interface ServerOptions {
  /** Base URL of the running app. Defaults to `HEALTHVAULT_URL` or `http://127.0.0.1:3040`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to `HEALTHVAULT_TIMEOUT_MS` or 15000. */
  timeoutMs?: number;
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
            `Check the service with "${STATUS_HINT}" and start it with "${START_HINT}".`,
          { tool, reason: error },
        );
      }

      throw new HealthVaultError(
        `Cannot reach HealthVault at ${baseUrl}. Start it with "${START_HINT}" ` +
          `(or check "${STATUS_HINT}").`,
        { tool, reason: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  return { baseUrl, timeoutMs, request };
}
