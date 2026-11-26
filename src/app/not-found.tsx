import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">That route does not exist.</p>
      <Link href="/" className="text-sm text-primary underline underline-offset-4">
        Back to Dashboard
      </Link>
    </div>
  );
}
