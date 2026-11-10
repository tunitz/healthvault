import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "Sign in" };

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

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-12">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      </div>
      <LoginForm next={next} />
    </div>
  );
}
