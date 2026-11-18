import { SecurityForm } from "@/components/settings/security-form";
import { SettingsPanel } from "@/components/settings/settings-panel";

// Integrated with the Security panel supplied by the parallel auth worker. This shell only
// composes their component; all password/session API calls live in that component's owner.
export default function SecuritySettingsPage() {
  return (
    <SettingsPanel
      title="Security"
      description="Change your password. Other sessions are signed out immediately."
    >
      <SecurityForm />
    </SettingsPanel>
  );
}
