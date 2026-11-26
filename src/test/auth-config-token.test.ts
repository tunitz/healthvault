import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "@/lib/auth";
import { getAuthConfig } from "@/lib/auth-config";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-auth-token-test-"));
const tokenFile = join(scratchDir, "agent.token");
const token = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
chmodSync(tokenFile, 0o600);
process.env.HEALTHVAULT_PASSWORD_HASH = hashPassword("auth-token-test-password");
process.env.HEALTHVAULT_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.HEALTHVAULT_API_TOKEN_FILE = tokenFile;
delete process.env.HEALTHVAULT_API_TOKEN;

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

describe("agent token configuration", () => {
  test("loads a token from the configured owner-only file", () => {
    expect(getAuthConfig().agentToken).toBe(token);
  });
});
