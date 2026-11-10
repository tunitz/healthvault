/**
 * Plugin entrypoint for OpenCode V2.
 *
 * OpenCode loads this package through its `exports["."]` entry and calls
 * `setup` once. Setup only registers tools; it performs no network I/O, so a
 * stopped HealthVault service cannot break OpenCode startup. The actionable
 * "start the service" error is raised on the first tool call instead.
 */

import { Plugin } from "@opencode/plugin";
import { createClient } from "./src/client";
import {
  createToolDefinitions,
  TOOL_NAMESPACE,
  TOOL_NAMESPACE_DESCRIPTION,
} from "./src/tools";

function optionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionNumber(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export default Plugin.define({
  id: "healthvault",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const client = createClient({
      baseUrl: optionString(options, "baseUrl"),
      timeoutMs: optionNumber(options, "timeoutMs"),
    });
    const tools = createToolDefinitions(client);

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: TOOL_NAMESPACE,
        description: TOOL_NAMESPACE_DESCRIPTION,
      });
      for (const tool of tools) editor.add(tool);
    });
  },
});
