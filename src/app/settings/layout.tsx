import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage how Health Vault looks and behaves.</p>
      </div>
      <div className="flex flex-col gap-5 md:flex-row md:items-start">
        <SettingsNav />
        <div className="min-w-0 flex-1 space-y-5">{children}</div>
      </div>
    </div>
  );
}
