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

describe("HealthVault agent client — extended tool surface", () => {
  /** Stub one tool and record the exact request the client sends. */
  function stubResult(tool: string, result: unknown) {
    let seen: { method: string; path: string; body: string } | undefined;
    const baseUrl = startStub(async (request) => {
      seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
      };
      return Response.json({ ok: true, tool, result });
    });
    return { baseUrl, seen: () => seen };
  }

  test("measurement_delete posts the id and returns the deletion result", async () => {
    const stub = stubResult("measurement_delete", { deleted: true });
    const client = createClient({ baseUrl: stub.baseUrl });

    expect(await client.measurementDelete({ id: 7 })).toEqual({ deleted: true });
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/measurement_delete",
      body: '{"id":7}',
    });
  });

  test("food_delete posts the id", async () => {
    const stub = stubResult("food_delete", { deleted: true });
    const client = createClient({ baseUrl: stub.baseUrl });

    expect(await client.foodDelete({ id: 12 })).toEqual({ deleted: true });
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/food_delete",
      body: '{"id":12}',
    });
  });

  test("copy_day posts both days and returns the copied count", async () => {
    const stub = stubResult("copy_day", { copied: 3, toDay: "2026-11-11" });
    const client = createClient({ baseUrl: stub.baseUrl });

    expect(
      await client.copyDay({ fromDay: "2026-11-10", toDay: "2026-11-11" }),
    ).toEqual({ copied: 3, toDay: "2026-11-11" });
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/copy_day",
      body: '{"fromDay":"2026-11-10","toDay":"2026-11-11"}',
    });
  });

  test("record_types posts an empty JSON object", async () => {
    const stub = stubResult("record_types", [
      {
        typeIdentifier: "HKQuantityTypeIdentifierStepCount",
        unit: "count",
        count: 10,
        firstDay: "2026-11-01",
        lastDay: "2026-11-10",
        sum: 12345,
        avg: 1234.5,
        max: 4000,
      },
    ]);
    const client = createClient({ baseUrl: stub.baseUrl });

    const stats = await client.recordTypes();
    expect(stats).toHaveLength(1);
    expect(stats[0]?.typeIdentifier).toBe("HKQuantityTypeIdentifierStepCount");
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/record_types",
      body: "{}",
    });
  });

  test("records_recent posts the type and limit and returns raw rows", async () => {
    const stub = stubResult("records_recent", {
      type: "HKQuantityTypeIdentifierStepCount",
      rows: [
        {
          day: "2026-11-10",
          startDate: "2026-11-10 08:00:00 +0100",
          endDate: "2026-11-10 08:05:00 +0100",
          value: 120,
          unit: "count",
          sourceName: "iPhone",
        },
      ],
    });
    const client = createClient({ baseUrl: stub.baseUrl });

    const result = await client.recordsRecent({
      type: "HKQuantityTypeIdentifierStepCount",
      limit: 25,
    });
    expect(result.type).toBe("HKQuantityTypeIdentifierStepCount");
    expect(result.rows).toHaveLength(1);
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/records_recent",
      body: '{"type":"HKQuantityTypeIdentifierStepCount","limit":25}',
    });
  });

  test("uploads_recent posts an empty object when no limit is given", async () => {
    const stub = stubResult("uploads_recent", [
      {
        filename: "export.zip",
        bytes: 1024,
        status: "done",
        recordsInserted: 10,
        recordsDuplicates: 2,
        message: null,
        createdAtMs: 1,
        finishedAtMs: 2,
      },
    ]);
    const client = createClient({ baseUrl: stub.baseUrl });

    const uploads = await client.uploadsRecent();
    expect(uploads[0]?.filename).toBe("export.zip");
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/uploads_recent",
      body: "{}",
    });
  });

  test("supplement_history posts the day window", async () => {
    const stub = stubResult("supplement_history", [
      {
        day: "2026-11-10",
        taken: 1,
        items: [{ name: "Vitamin D", dose: 1000, unit: "IU", takenAtMs: 5 }],
      },
    ]);
    const client = createClient({ baseUrl: stub.baseUrl });

    const history = await client.supplementHistory({ days: 30 });
    expect(history[0]?.items[0]?.name).toBe("Vitamin D");
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/supplement_history",
      body: '{"days":30}',
    });
  });

  test("supplement_delete posts the id and reports archive-vs-delete", async () => {
    const stub = stubResult("supplement_delete", {
      deleted: false,
      archived: true,
    });
    const client = createClient({ baseUrl: stub.baseUrl });

    expect(await client.supplementDelete({ id: 4 })).toEqual({
      deleted: false,
      archived: true,
    });
    expect(stub.seen()).toEqual({
      method: "POST",
      path: "/api/agent/supplement_delete",
      body: '{"id":4}',
    });
  });
});
