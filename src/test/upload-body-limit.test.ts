/**
 * The regression these tests pin: `src/proxy.ts` runs on every request, so Next buffers each
 * request body to let the proxy and the route handler both read it. Its default cap is 10 MB and
 * an oversized body is **truncated, not rejected** — `POST /api/upload` then received a cut-off
 * multipart stream, `req.formData()` threw, and a real ~20 MB `Export.zip` failed with
 * "expected multipart/form-data". Nothing else in the stack noticed: the route check is on
 * `file.size` *after* parsing, so it never ran.
 *
 * The fix lives in `next.config.ts` (`experimental.proxyClientMaxBodySize`). These tests read the
 * config and the route cap directly, then prove the failure mode itself with a truncated
 * multipart body, so the pairing cannot silently drift back to the default again.
 */
import { describe, expect, test } from "bun:test";
import nextConfig from "../../next.config";
import { MAX_UPLOAD_BYTES } from "@/app/api/upload/route";

/** Next accepts bytes or a `b`/`kb`/`mb`/`gb` string; the built config normalises to bytes. */
function bodyLimitBytes(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new Error(`unsupported size limit: ${String(value)}`);
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim());
  if (!match) throw new Error(`unsupported size limit: ${value}`);
  const scale = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[match[2].toLowerCase() as "b"];
  return Number(match[1]) * scale;
}

describe("upload body limit", () => {
  test("the proxy body cap leaves room for a whole Export.zip plus its multipart envelope", () => {
    const limit = bodyLimitBytes(nextConfig.experimental?.proxyClientMaxBodySize);
    expect(limit).toBeGreaterThan(MAX_UPLOAD_BYTES);
    // The envelope is a few hundred bytes: a fixed headroom, not a percentage.
    expect(limit - MAX_UPLOAD_BYTES).toBeGreaterThanOrEqual(1024);
  });

  test("the route cap is the documented 200 MB zip limit", () => {
    expect(MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024);
  });

  test("a body truncated at the old 10 MB default cannot be parsed as the form the route expects", async () => {
    const boundary = "----healthvault-upload-test";
    const file = "x".repeat(2_000_000);
    const full =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="export.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n${file}\r\n` +
      `--${boundary}--\r\n`;
    // Cut it the way Next's clone trims an oversized body: no closing boundary survives.
    const truncated = full.slice(0, 1_500_000);

    // `formData()` throws synchronously in Bun, so capture either form of failure.
    const attempt = async () => {
      const request = new Request("http://127.0.0.1:3040/api/upload", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: truncated,
      });
      return request.formData();
    };

    // This rejection is what POST /api/upload turns into "expected multipart/form-data".
    await expect(attempt()).rejects.toThrow();
  });

  test("the same body parses when it arrives whole", async () => {
    const boundary = "----healthvault-upload-test";
    const file = "x".repeat(2_000_000);
    const full =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="export.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n${file}\r\n` +
      `--${boundary}--\r\n`;

    const form = await new Request("http://127.0.0.1:3040/api/upload", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: full,
    }).formData();

    const uploaded = form.get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).size).toBe(file.length);
  });
});
