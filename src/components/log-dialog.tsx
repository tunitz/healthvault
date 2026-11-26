"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Shared shell for every manual logging form.
 *
 * One dialog shape everywhere: a compact centered panel on desktop, a wide
 * inset panel on phones. The header and footer stay put while only the body
 * scrolls, so the primary action is always reachable when a keyboard is open.
 */
export function LogDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[min(90dvh,860px)] w-[calc(100%-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0",
          "sm:max-h-[min(88dvh,780px)] sm:max-w-none sm:w-[min(560px,calc(100vw-3rem))]",
          size === "sm" && "sm:w-[min(440px,calc(100vw-3rem))]",
          size === "lg" && "sm:w-[min(760px,calc(100vw-3rem))]",
          className,
        )}
      >
        <DialogHeader className="shrink-0 gap-1 border-b px-4 py-3 pr-12 sm:px-5">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div data-slot="dialog-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-6 sm:px-5">
          {children}
        </div>
        {footer ? (
          <div data-slot="dialog-footer" className="shrink-0 border-t bg-muted/40 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
