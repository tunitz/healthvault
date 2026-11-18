import type { Metadata } from "next";
import { McpForm } from "@/components/settings/mcp-form";
import { SettingsPanel } from "@/components/settings/settings-panel";

export const metadata: Metadata = { title: "MCP access" };

export default function McpSettingsPage() {
  return (
    <div className="space-y-5">
      <SettingsPanel
        title="MCP access"
        description="Control machine access to your health data."
      >
        <McpForm />
      </SettingsPanel>
    </div>
  );
}
