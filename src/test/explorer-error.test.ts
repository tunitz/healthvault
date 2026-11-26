/**
 * The explorer used to swallow fetch failures and render "No rows for this type.", hiding the
 * error. These pin the actionable message text and the visible message + Retry target, so a
 * failed records request can never again look like an empty dataset.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExplorerError, explorerFetchError } from "@/components/explorer-client";

describe("explorerFetchError", () => {
  test("network failures point at the connection and retry", () => {
    expect(explorerFetchError(null)).toMatch(/connection and retry/);
  });

  test("auth failures tell the user to sign in again", () => {
    expect(explorerFetchError(401)).toMatch(/sign in again/i);
    expect(explorerFetchError(403)).toMatch(/sign in again/i);
  });

  test("server and other failures name the status", () => {
    expect(explorerFetchError(500)).toContain("500");
    expect(explorerFetchError(404)).toContain("404");
  });
});

describe("ExplorerError", () => {
  test("renders an alert with the failure message and a 44px Retry target", () => {
    const html = renderToStaticMarkup(
      createElement(ExplorerError, { message: "Server error (500).", onRetry: () => {} }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Server error (500).");
    expect(html).toContain("Retry");
    expect(html).toContain("min-h-11");
  });
});
