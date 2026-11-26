"use client";

import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type McpFlags = { enabled: boolean; lanEnabled: boolean };
type Status = McpFlags & {
  revision: number;
  endpoint: string;
  transports: string[];
};
type Snapshot = {
  value: Record<string, unknown> & { mcp: McpFlags };
  revision: number;
};
type TokenState = { token: string | null; source: "stored" | "env" | null };

async function loadState(): Promise<{ status: Status; snapshot: Snapshot; token: TokenState }> {
  const [statusResponse, settingsResponse, tokenResponse] = await Promise.all([
    fetch("/api/mcp/status", { cache: "no-store" }),
    fetch("/api/settings", { cache: "no-store" }),
    fetch("/api/auth/token", { cache: "no-store" }),
  ]);
  if (!statusResponse.ok || !settingsResponse.ok || !tokenResponse.ok) {
    throw new Error("Could not load MCP status");
  }
  return {
    status: (await statusResponse.json()) as Status,
    snapshot: (await settingsResponse.json()) as Snapshot,
    token: (await tokenResponse.json()) as TokenState,
  };
}

function maskToken(token: string): string {
  return `••••••••••••${token.slice(-4)}`;
}

/** Settings → MCP. Real enable/LAN controls plus a masked, rotatable harness token. */
export function McpForm({
  initialState,
}: {
  initialState?: { status: Status; snapshot: Snapshot; token: TokenState };
} = {}) {
  const [status, setStatus] = useState<Status | null>(initialState?.status ?? null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(initialState?.snapshot ?? null);
  const [token, setToken] = useState<TokenState | null>(initialState?.token ?? null);
  const [error, setError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [pending, setPending] = useState(false);
  const [tokenPending, setTokenPending] = useState(false);

  useEffect(() => {
    if (initialState) return;
    let active = true;
    loadState()
      .then((loaded) => {
        if (!active) return;
        setStatus(loaded.status);
        setSnapshot(loaded.snapshot);
        setToken(loaded.token);
        setError(null);
      })
      .catch(() => {
        if (active) setError("Could not load MCP status. Reload the page to try again.");
      });
    return () => {
      active = false;
    };
  }, [initialState]);

  async function reload() {
    const loaded = await loadState();
    setStatus(loaded.status);
    setSnapshot(loaded.snapshot);
    setToken(loaded.token);
    setError(null);
  }

  async function save(next: McpFlags) {
    if (!snapshot || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: { ...snapshot.value, mcp: next },
          revision: snapshot.revision,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown; revision?: number } | null;
      if (response.status === 409) {
        setError("Settings changed elsewhere. Reloaded the current values — try again.");
        await reload();
        return;
      }
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "Could not save MCP settings");
      }
      const revision = body?.revision ?? snapshot.revision + 1;
      const value = { ...snapshot.value, mcp: next };
      setSnapshot({ value, revision });
      setStatus((previous) => (previous ? { ...previous, ...next, revision } : previous));
      toast.success("MCP access updated");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save MCP settings");
      toast.error("Could not update MCP access");
    } finally {
      setPending(false);
    }
  }

  async function rotateToken() {
    if (tokenPending) return;
    setTokenPending(true);
    setTokenError(null);
    try {
      const response = await fetch("/api/auth/token", { method: "POST", cache: "no-store" });
      const body = (await response.json().catch(() => null)) as TokenState & { error?: unknown } | null;
      if (!response.ok || !body?.token) {
        const message = typeof body?.error === "string" ? body.error : "Could not rotate the harness token";
        if (response.status === 409) await reload();
        throw new Error(message);
      }
      setToken({ token: body.token, source: body.source });
      setRevealed(false);
      setConfirmRotate(false);
      toast.success("Harness token rotated — update your harnesses");
    } catch (cause) {
      setTokenError(cause instanceof Error ? cause.message : "Could not rotate the harness token");
      toast.error("Could not rotate the harness token");
    } finally {
      setTokenPending(false);
    }
  }

  async function copyToken() {
    if (!token?.token) return;
    try {
      await navigator.clipboard.writeText(token.token);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy — select and copy the token manually");
    }
  }

  const enabled = status?.enabled ?? false;
  const lanEnabled = status?.lanEnabled ?? false;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={enabled ? "default" : "secondary"} aria-live="polite">
          {enabled ? "MCP on" : "MCP off"}
        </Badge>
        <Badge variant={lanEnabled ? "outline" : "secondary"} aria-live="polite">
          {lanEnabled ? "LAN enabled" : "Local only"}
        </Badge>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="space-y-3">
        <label className="flex items-start gap-3 rounded-lg border p-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={enabled}
            disabled={pending || status === null}
            onChange={(event) => void save({ enabled: event.target.checked, lanEnabled })}
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">Enable MCP machine access</span>
            <span className="block text-xs text-muted-foreground">
              Turns on both connectors. Off blocks all machine access; the web app keeps working.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-lg border p-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={lanEnabled}
            disabled={pending || status === null || !enabled}
            onChange={(event) => void save({ enabled, lanEnabled: event.target.checked })}
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">Allow LAN access</span>
            <span className="block text-xs text-muted-foreground">
              Off accepts only local clients. Also add the LAN host to HEALTHVAULT_ALLOWED_HOSTS.
            </span>
          </span>
        </label>
      </div>

      <section className="space-y-2 border-t pt-4 text-sm">
        <h3 className="font-medium">Harness token</h3>
        <p className="text-xs text-muted-foreground">
          Grants machine access to your health data — treat it as a secret. Rotating stops the old
          token working immediately, so update every harness that uses it.
        </p>

        {tokenError ? (
          <p role="alert" className="text-sm text-destructive">
            {tokenError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <code
            className="min-w-0 flex-1 break-all rounded-md border bg-muted px-2 py-2 font-mono text-xs"
            aria-label={token?.token ? (revealed ? "Harness token" : "Harness token, masked") : "No harness token"}
          >
            {token?.token ? (revealed ? token.token : maskToken(token.token)) : "No token configured"}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={!token?.token}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <EyeOff /> : <Eye />}
            {revealed ? "Hide" : "Reveal"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={!token?.token}
            onClick={() => void copyToken()}
          >
            <Copy />
            Copy
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="min-h-11"
            disabled={tokenPending || (confirmRotate && !!token?.token)}
            onClick={() => (token?.token ? setConfirmRotate(true) : void rotateToken())}
          >
            <RefreshCw />
            {token?.token ? "Rotate token" : "Generate token"}
          </Button>
        </div>

        {confirmRotate && token?.token ? (
          <div
            role="group"
            aria-label="Confirm token rotation"
            className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2"
          >
            <p className="w-full text-xs text-destructive">
              This invalidates the current token for every harness. Continue?
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="min-h-11"
              disabled={tokenPending}
              onClick={() => void rotateToken()}
            >
              <RefreshCw />
              Confirm rotate
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              disabled={tokenPending}
              onClick={() => setConfirmRotate(false)}
            >
              Cancel
            </Button>
          </div>
        ) : null}

        {token?.source ? (
          <p className="text-xs text-muted-foreground">
            {token.source === "stored" ? "Managed here in Settings" : "From the server environment"}
          </p>
        ) : null}
      </section>

      <div className="space-y-2 border-t pt-4 text-sm">
        <h3 className="font-medium">Connect a harness</h3>
        <p className="text-xs text-muted-foreground">
          Portable connection details for any MCP client. View, copy and rotate the token above, or
          sign in through the browser.
        </p>
        <dl className="space-y-3 text-xs">
          <div className="space-y-1">
            <dt className="font-medium">Direct HTTP (Streamable HTTP)</dt>
            <dd className="space-y-1 text-muted-foreground">
              <p>
                <code className="rounded bg-muted px-1 py-0.5">POST /api/mcp</code>
              </p>
              <p>
                Relative to this app&apos;s URL · JSON-RPC 2.0 · initialize · notifications/initialized
                · ping · tools/list · tools/call
              </p>
              <p>Send Authorization: Bearer &lt;your token&gt; or a signed-in session.</p>
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="font-medium">stdio connector (local)</dt>
            <dd className="text-muted-foreground">
              <code className="rounded bg-muted px-1 py-0.5">bun plugins/healthvault/src/mcp.ts</code>
              <p>Uses HEALTHVAULT_TOKEN or HEALTHVAULT_TOKEN_FILE from the process environment.</p>
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Imports stay manual — there is no MCP upload tool.
        </p>
      </div>
    </div>
  );
}
