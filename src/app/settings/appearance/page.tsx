import type { Metadata } from "next";
import { AppearanceForm } from "@/components/settings/appearance-form";
import { SettingsPanel } from "@/components/settings/settings-panel";

export const metadata: Metadata = { title: "Appearance" };

/** Settings → Appearance is the only theme-switch location in the app. */
export default function AppearanceSettingsPage() {
  return (
    <div className="space-y-5">
      <SettingsPanel
        title="Appearance"
        description="Preview changes here, then save them to sync across your devices."
      >
        <AppearanceForm />
      </SettingsPanel>
    </div>
  );
}
