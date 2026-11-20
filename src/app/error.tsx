"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const handleRetry = () => {
    if (typeof retry === "function") retry();
    else if (typeof reset === "function") reset();
    else window.location.reload();
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        The page could not be loaded. Try again; if it keeps failing, check the server log.
      </p>
      {error.digest ? <p className="num text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleRetry}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Back to Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
