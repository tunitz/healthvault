import { ExplorerClient } from "@/components/explorer-client";
import { typeStats } from "@/db/queries";

export const dynamic = "force-dynamic";

export default function ExplorerPage() {
  const types = typeStats();
  if (types.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Explorer</h1>
        <p className="text-sm text-muted-foreground">Upload an Export.zip to browse record types.</p>
      </div>
    );
  }
  return <ExplorerClient types={types} />;
}
