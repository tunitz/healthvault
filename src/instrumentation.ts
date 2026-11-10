/**
 * Fail fast at boot when credentials are missing or malformed. `next build` never has them
 * (and must not need them), so skip validation in the build phase. Auth config reads Node
 * builtins, so it is imported lazily and only on the Node.js runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "edge") return;

  const { getAuthConfig } = await import("@/lib/auth-config");
  try {
    getAuthConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth] refusing to start: ${message}`);
    throw error;
  }
}
