import Link from "next/link";
import { Database, Download, History, Search, Upload, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsPanel } from "@/components/settings/settings-panel";

const TOOLS: { href: string; label: string; description: string; Icon: LucideIcon }[] = [
  {
    href: "/explorer",
    label: "Explorer",
    description: "Browse imported Apple Health records, daily trends, and ECG strips.",
    Icon: Search,
  },
  {
    href: "/uploads",
    label: "Import",
    description: "Import an Apple Health Export.zip manually.",
    Icon: Upload,
  },
  {
    href: "/nutrition/corrections",
    label: "Past meals",
    description: "Review logged meals and their snapshot corrections.",
    Icon: History,
  },
];

export default function DataToolsSettingsPage() {
  return (
    <div className="flex flex-col gap-6">
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
      </SettingsPanel>

      <SettingsPanel
        title="Export & backup"
        description="Download your manual tracking data as JSON/CSV or take a WAL-safe SQLite database snapshot."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Manual data export</h3>
            <p className="text-xs text-muted-foreground">
              Exports profile, measurements, foods, recipes, food log, supplements, training plan, and strength sets. Credentials and tokens are never included.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href="/api/export?format=json" download>
                  <Download aria-hidden className="size-3.5" />
                  Full JSON bundle
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href="/api/export?format=csv&table=food_log" download>
                  <Download aria-hidden className="size-3.5" />
                  Food log CSV
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href="/api/export?format=csv&table=measurements" download>
                  <Download aria-hidden className="size-3.5" />
                  Measurements CSV
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href="/api/export?format=csv&table=strength" download>
                  <Download aria-hidden className="size-3.5" />
                  Strength CSV
                </a>
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-medium">SQLite database backup</h3>
            <p className="text-xs text-muted-foreground">
              Creates a consistent online backup using SQLite&apos;s WAL-safe backup API, including imported Apple Health data.
            </p>
            <div>
              <Button asChild size="sm">
                <a href="/api/backup" download>
                  <Database aria-hidden className="size-3.5" />
                  Download SQLite backup (.db)
                </a>
              </Button>
            </div>
          </div>
        </div>
      </SettingsPanel>
    </div>
  );
}
