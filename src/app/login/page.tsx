import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { SetupForm } from "@/components/setup-form";
import { getAuthState } from "@/lib/auth-config";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next =
    typeof params.next === "string" && params.next.startsWith("/") && !params.next.startsWith("//")
      ? params.next
      : "/";
  const unconfigured = getAuthState() === "unconfigured";

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-12">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{unconfigured ? "Set up HealthVault" : "Sign in"}</h1>
        {unconfigured ? (
          <p className="text-sm text-muted-foreground">Create the password for this installation to continue.</p>
        ) : null}
      </div>
      {unconfigured ? <SetupForm next={next} /> : <LoginForm next={next} />}
    </div>
  );
}
