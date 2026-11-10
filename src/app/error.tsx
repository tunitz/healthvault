"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        The page could not be loaded. Try again; if it keeps failing, check the server log.
      </p>
      {error.digest ? <p className="num text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
      <Button onClick={() => retry()}>Try again</Button>
    </div>
  );
}
