import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { healthvaultContext } from "@/lib/services/context";
import { getSettings } from "@/lib/services/settings";
import { Dashboard } from "@/components/dashboard/dashboard";
import { hasDashboardContent } from "@/components/dashboard/data";
import { dashboardContentInput, loadDashboardData } from "@/components/dashboard/widget-data";
import { orderedVisibleWidgets } from "@/components/dashboard/registry";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: { absolute: "Dashboard · Health Vault" } };

export default function DashboardPage() {
  const context = healthvaultContext();
  const settings = getSettings().value;

  // Import onboarding only when there is genuinely nothing to show. A manual meal, measurement,
  // supplement log or prior import is real content even when zero Apple records were imported.
  if (!hasDashboardContent(dashboardContentInput(context))) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Logo size={40} />
        <h1 className="text-2xl font-semibold tracking-tight">No health data yet</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Export your data on the iPhone: Health app → your picture → Export All Health Data, then
          import the resulting <code>Export.zip</code> on the Import page. You can also log meals,
          measurements and supplements directly without importing.
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          {context.profile.started
            ? "Your profile is set. Import an export or log something to fill the dashboard."
            : "Set up your profile now so the agent has your height, birth date and goals on file."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/uploads">Import an export</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/profile">{context.profile.started ? "View profile" : "Set up profile"}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const widgets = settings.dashboard.widgets;
  const usedRanges = orderedVisibleWidgets(widgets).map(({ pref }) => pref.range);
  const data = loadDashboardData(context, usedRanges);

  return <Dashboard context={context} data={data} widgets={widgets} />;
}
