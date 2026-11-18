import type { Metadata } from "next";
import Link from "next/link";
import { DashboardForm } from "@/components/settings/dashboard-form";
import { SettingsPanel } from "@/components/settings/settings-panel";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardSettingsPage() {
  return (
    <div className="space-y-5">
      <SettingsPanel
        title="Dashboard layout"
        description="Choose which cards appear, their order and size, and how each one renders."
      >
        <DashboardForm />
      </SettingsPanel>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        View dashboard
      </Link>
    </div>
  );
}
