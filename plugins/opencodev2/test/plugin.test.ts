import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "../src/client";
import { HealthVaultError } from "../src/server";

type StubServer = ReturnType<typeof Bun.serve>;

let stub: StubServer | undefined;

afterEach(() => {
  stub?.stop(true);
  stub = undefined;
});

function startStub(
  handler: (request: Request) => Response | Promise<Response>,
): string {
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  return `http://127.0.0.1:${stub.port}`;
}

describe("HealthVault agent client", () => {
  test("read tool returns the server result and posts the expected request", async () => {
    let seen:
      | {
          method: string;
          path: string;
          contentType: string | null;
          body: string;
        }
      | undefined;

    const baseUrl = startStub(async (request) => {
      seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        body: await request.text(),
      };
      return Response.json({
        ok: true,
        tool: "nutrition_day",
        result: { day: "2026-11-10", totals: { kcal: 0 } },
      });
    });

    const client = createClient({ baseUrl });
    const result = await client.nutritionDay({ day: "2026-11-10" });

    expect(result.day).toBe("2026-11-10");
    expect(result.totals.kcal).toBe(0);
    expect(seen).toEqual({
      method: "POST",
      path: "/api/agent/nutrition_day",
      contentType: "application/json",
      body: '{"day":"2026-11-10"}',
    });
  });

  test("no-input tool posts an empty JSON object", async () => {
    let seen: { path: string; body: string } | undefined;

    const baseUrl = startStub(async (request) => {
      seen = {
        path: new URL(request.url).pathname,
        body: await request.text(),
      };
      return Response.json({
        ok: true,
        tool: "healthvault_context",
        result: { today: "2026-11-10" },
      });
    });

    const client = createClient({ baseUrl });
    const result = await client.healthvaultContext();

    expect(result.today).toBe("2026-11-10");
    expect(seen).toEqual({
      path: "/api/agent/healthvault_context",
      body: "{}",
    });
  });

  test("propagates the server's error message and status on a 400", async () => {
    const baseUrl = startStub(() =>
      Response.json(
        {
          ok: false,
          tool: "measurement_add",
          error: "value must be a number",
        },
        { status: 400 },
      ),
    );

    const client = createClient({ baseUrl });
    let caught: unknown;
    try {
      await client.measurementAdd({ kind: "weight", value: 80 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HealthVaultError);
    if (!(caught instanceof HealthVaultError)) {
      throw new Error("expected a HealthVaultError");
    }
    expect(caught.status).toBe(400);
    expect(caught.tool).toBe("measurement_add");
    expect(caught.message).toContain("value must be a number");
  });

  test("unreachable service produces an actionable start command", async () => {
    const probe = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    const port = probe.port;
    await probe.stop(true);

    const client = createClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 2000,
    });

    let caught: unknown;
    try {
      await client.healthvaultContext();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HealthVaultError);
    if (!(caught instanceof HealthVaultError)) {
      throw new Error("expected a HealthVaultError");
    }
    expect(caught.message).toContain("systemctl --user start healthvault");
    expect(caught.message).toContain(`http://127.0.0.1:${port}`);
  });
});
