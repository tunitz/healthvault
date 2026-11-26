import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupForm } from "@/components/setup-form";
import { getAuthState } from "@/lib/auth-config";

export const metadata: Metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

export default function SetupPage() {
  // Setup closes permanently once credentials exist (legacy env or stored).
  if (getAuthState() !== "unconfigured") redirect("/login");

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-12">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Set up HealthVault</h1>
        <p className="text-sm text-muted-foreground">Create the password for this installation to continue.</p>
      </div>
      <SetupForm />
    </div>
  );
}
