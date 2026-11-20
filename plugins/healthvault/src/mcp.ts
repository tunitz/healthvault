#!/usr/bin/env bun
/**
 * `healthvault-mcp` — an MCP stdio server exposing the HealthVault agent API to
 * any MCP harness.
 *
 * Tools, resources, and prompts are registered through the low-level request handlers on the
 * McpServer's underlying Server so the JSON Schemas in `definitions.ts` reach the client
 * verbatim. Nothing is ever written to stdout except MCP JSON-RPC; diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./client";
import {
  buildPromptMessages,
  createToolDefinitions,
  INSTRUCTIONS,
  MCP_PROMPTS,
  MCP_RESOURCES,
  SERVER_NAME,
  SERVER_VERSION,
  type ToolDefinition,
} from "./definitions";
import { resolveBaseUrl, resolveTimeoutMs } from "./server";

export { INSTRUCTIONS };

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createHealthVaultServer(definitions: ToolDefinition[]): McpServer {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: INSTRUCTIONS,
    },
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
          content: [{ type: "text", text: JSON.stringify(result) ?? "null" }],
          ...(isRecord(result) ? { structuredContent: result } : {}),
        };
      } catch (error) {
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

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: MCP_RESOURCES.map(({ uri, name, description, mimeType }) => ({
      uri,
      name,
      description,
      mimeType,
    })),
  }));

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const resource = MCP_RESOURCES.find((r) => r.uri === request.params.uri);
    if (!resource) {
      throw new Error(`Resource not found: ${request.params.uri}`);
    }
    const mcpToolName = resource.tool.startsWith("healthvault_")
      ? resource.tool
      : `healthvault_${resource.tool}`;
    const definition = byName.get(mcpToolName);
    if (!definition) {
      throw new Error(`Backing tool not available for resource ${resource.uri}`);
    }
    const result = await definition.run(resource.args, extra.signal);
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: JSON.stringify(result) ?? "null",
        },
      ],
    };
  });

  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MCP_PROMPTS.map(({ name, description, arguments: promptArgs }) => ({
      name,
      description,
      ...(promptArgs
        ? {
            arguments: promptArgs.map((arg) => ({
              name: arg.name,
              description: arg.description,
              required: arg.required,
            })),
          }
        : {}),
    })),
  }));

  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = buildPromptMessages(request.params.name, request.params.arguments);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    return prompt;
  });

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

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `healthvault-mcp failed to start: ${errorText(error, "unknown error")}\n`,
    );
    process.exit(1);
  });
}
