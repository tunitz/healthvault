import { describe, expect, test } from "bun:test";
import { createClient } from "../src/client";
import { createToolDefinitions, TOOL_NAMESPACE, TOOL_NAMES } from "../src/tools";

/**
 * The agent route names the context tool `healthvault_context` but leaves every
 * other tool unprefixed (see `src/app/api/agent/[tool]/route.ts`), while the
 * model sees all of them prefixed with the plugin namespace.
 */
const routeName = (name: string) =>
  name === "context" ? "healthvault_context" : name;

describe("plugin tool surface parity", () => {
  test("definitions cover AGENT_TOOLS one-to-one and in order", async () => {
    const { AGENT_TOOLS } = await import("../../../src/lib/agent-tools");
    const definitions = createToolDefinitions(createClient());

    expect(definitions.map((definition) => routeName(definition.name))).toEqual([
      ...AGENT_TOOLS,
    ]);
    const toolNames: readonly string[] = TOOL_NAMES;
    expect(toolNames).toEqual(
      definitions.map((definition) => `${TOOL_NAMESPACE}_${definition.name}`),
    );
    expect(TOOL_NAMES).toHaveLength(27);
  });

  test("every definition registers as a direct, namespaced tool row", () => {
    const definitions = createToolDefinitions(createClient());

    for (const definition of definitions) {
      expect(definition.options.namespace).toBe(TOOL_NAMESPACE);
      expect(definition.options.codemode).toBe(false);
    }
  });
});
