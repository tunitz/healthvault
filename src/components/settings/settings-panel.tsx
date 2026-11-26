import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsPanel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-xl border bg-card p-4 text-card-foreground shadow-sm sm:p-5", className)}
    >
      <div className="mb-4 space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Text-first "coming later" marker — never colour-only, never an invented API call. */
export function PlannedNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">Planned.</span> {children}
    </div>
  );
}
