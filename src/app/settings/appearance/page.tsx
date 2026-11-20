import type { Metadata } from "next";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { getSettings } from "@/lib/services/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Appearance" };

/** Settings → Appearance. Initial settings are passed from the server to prevent a loading flash. */
export default function AppearanceSettingsPage() {
  const initialSnapshot = getSettings();
  return (
    <div className="space-y-5">
      <SettingsPanel
        title="Appearance"
        description="Preview changes here, then save them to sync across your devices."
      >
        <AppearanceForm initialSnapshot={initialSnapshot} />
      </SettingsPanel>
    </div>
  );
}
