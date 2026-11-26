/**
 * Boot check. A completely unconfigured single-user install is valid: it opens /setup and the
 * health data + MCP surfaces stay unavailable until the first password is created. We therefore
 * log a clear, non-secret message instead of throwing. A *malformed* legacy env credential still
 * fails fast — that is a broken config, not a first run. `next build` never has credentials (and
 * must not need them), so validation is skipped in the build phase; auth config and the DB read
 * Node builtins, so they are imported lazily and only on the Node.js runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "edge") return;

  const { getAuthState } = await import("@/lib/auth-config");
  try {
    const state = getAuthState();
    if (state === "unconfigured") {
      console.warn(
        "[auth] no credentials configured — first-run setup is required at /setup; " +
          "health data and MCP are unavailable until setup completes",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth] refusing to start: ${message}`);
    throw error;
  }
}
