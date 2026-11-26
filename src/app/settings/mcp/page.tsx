import type { Metadata } from "next";
import { McpForm } from "@/components/settings/mcp-form";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { getAgentTokenState } from "@/lib/services/agent-token";
import { getSettings } from "@/lib/services/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "MCP access" };

export default function McpSettingsPage() {
  const snapshot = getSettings();
  const token = getAgentTokenState();
  const mcp = snapshot.value.mcp ?? { enabled: false, lanEnabled: false };
  const status = {
    enabled: mcp.enabled,
    lanEnabled: mcp.lanEnabled,
    revision: snapshot.revision,
    endpoint: "/api/mcp",
    transports: ["http", "stdio"],
  };
  return (
    <div className="space-y-5">
      <SettingsPanel
        title="MCP access"
        description="Control machine access to your health data."
      >
        <McpForm
          initialState={{
            status,
            snapshot: { value: snapshot.value as unknown as Record<string, unknown> & { mcp: { enabled: boolean; lanEnabled: boolean } }, revision: snapshot.revision },
            token,
          }}
        />
      </SettingsPanel>
    </div>
  );
}
