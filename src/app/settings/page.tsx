import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Settings" };

/** The General section was retired from the nav; keep /settings out of the landing dead end. */
export default function SettingsPage() {
  redirect("/settings/appearance");
}
