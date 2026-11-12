#!/usr/bin/env bun
/**
 * `healthvault-mcp` — an MCP stdio server exposing the HealthVault agent API to
 * any MCP harness.
 *
 * Tools are registered through the low-level request handlers on the McpServer's
 * underlying Server so the JSON Schemas in `definitions.ts` reach the client
 * verbatim, exactly as the OpenCode plugin exposed them. Nothing is ever written
 * to stdout except MCP JSON-RPC; diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./client";
import { createToolDefinitions, type ToolDefinition } from "./definitions";
import { resolveBaseUrl, resolveTimeoutMs } from "./server";

const SERVER_NAME = "healthvault";
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Start every session with healthvault_context so answers use the user's current profile, timezone and today's local day, today's nutrition, weight trend, supplements, strength detail, training (including the current-week summary), and data freshness.",
  "Confirm destructive actions with the user first: deletes (healthvault_meal_delete, healthvault_food_delete, healthvault_measurement_delete, healthvault_supplement_delete) and the target day of healthvault_copy_day. healthvault_recipe_delete archives a recipe that has logged history instead of deleting it. For past-meal corrections after a food's nutrition changed, run healthvault_food_history_preview and confirm the exact rows before healthvault_food_history_refresh.",
  "Apple Health imports stay a manual user action: tools only read imported data, and healthvault_uploads_recent shows import history.",
].join(" ");

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

export function createHealthVaultServer(definitions: ToolDefinition[]): McpServer {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => ({
      tools: definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      })) as ListToolsResult["tools"],
    }),
  );

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const definition = byName.get(request.params.name);
      if (!definition) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown HealthVault tool "${request.params.name}".`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await definition.run(request.params.arguments ?? {}, extra.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "null" }],
        };
      } catch (error) {
        // The API client already turns transport and app failures into
        // actionable messages.
        return {
          content: [
            {
              type: "text",
              text: errorText(error, `HealthVault tool ${definition.name} failed.`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const client = createClient({
    baseUrl: resolveBaseUrl(),
    timeoutMs: resolveTimeoutMs(),
  });

  const server = createHealthVaultServer(createToolDefinitions(client));
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `healthvault-mcp failed to start: ${errorText(error, "unknown error")}\n`,
  );
  process.exit(1);
});
