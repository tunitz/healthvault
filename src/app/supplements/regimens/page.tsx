import type { Metadata } from "next";
import { listSupplements, parseSchedule } from "@/lib/services/supplements";
import { SupplementEditor } from "@/components/supplements/supplement-forms";
import { SubviewHeader, SubviewNav } from "@/components/subviews/subview-header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Supplement regimens" };

const SECTIONS = [
  { href: "/supplements", label: "Today" },
  { href: "/supplements/regimens", label: "Regimens" },
  { href: "/supplements/history", label: "History" },
] as const;

export default function SupplementRegimensPage() {
  const editorItems = listSupplements(false).map((supplement) => ({
    supplement,
    schedule: parseSchedule(supplement.scheduleJson),
  }));

  return (
    <div className="flex flex-col gap-8">
      <SubviewHeader
        title="Regimens"
        description="Add, edit or archive a supplement. Archiving keeps past intake."
        backHref="/supplements"
        backLabel="Today's checklist"
      >
        <SubviewNav label="Supplements sections" items={SECTIONS} activeHref="/supplements/regimens" />
      </SubviewHeader>

      <section className="flex flex-col gap-3" aria-label="Supplement regimens">
        <SupplementEditor items={editorItems} />
      </section>
    </div>
  );
}
