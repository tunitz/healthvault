import Link from "next/link";
import { History, Search, Upload, type LucideIcon } from "lucide-react";
import { PlannedNote, SettingsPanel } from "@/components/settings/settings-panel";

const TOOLS: { href: string; label: string; description: string; Icon: LucideIcon }[] = [
  {
    href: "/explorer",
    label: "Explorer",
    description: "Browse imported Apple Health records.",
    Icon: Search,
  },
  {
    href: "/uploads",
    label: "Import",
    description: "Import an Apple Health export manually.",
    Icon: Upload,
  },
  {
    href: "/nutrition/corrections",
    label: "Past meals",
    description: "Review logged meals and their corrections.",
    Icon: History,
  },
];

export default function DataToolsSettingsPage() {
  return (
    <SettingsPanel
      title="Data tools"
      description="Utilities for imported and logged data."
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {TOOLS.map(({ href, label, description, Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex min-h-16 flex-col justify-center gap-0.5 rounded-lg border px-3 py-2.5 transition-colors hover:bg-accent"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {label}
              </span>
              <span className="text-xs text-muted-foreground">{description}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <PlannedNote>
          Further export and data-management tools will appear here. Past-meal corrections stay
          contextual from food editing and meal history; this link preserves the existing deep
          link without making it a primary tab.
        </PlannedNote>
      </div>
    </SettingsPanel>
  );
}
