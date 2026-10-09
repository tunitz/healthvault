import { cn } from "@/lib/utils";

// Inline mark matching public/logo-mark.svg. Colours come from theme tokens so it adapts to light/dark.
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Health Vault"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={cn("shrink-0", className)}
    >
      <rect width="64" height="64" rx="14" fill="var(--primary)" />
      <path
        d="M10 34h11l5-12 6 22 6-16 3 6h13"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
