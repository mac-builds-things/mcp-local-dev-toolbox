/**
 * mcp-local-dev-toolbox — server entrypoint
 *
 * Starts a stdio-based MCP server and registers all tool modules.
 * Each tool module exports a list of ToolDefinition objects; this file
 * wires them into the MCP SDK's Server instance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { filesystemTools } from "./tools/filesystem.js";
import { gitTools } from "./tools/git.js";
import { testTools } from "./tools/tests.js";
import { searchTools } from "./tools/search.js";
import { SafetyChecker } from "./safety.js";
import type { ToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();
const ALLOW_WRITES = process.env.ALLOW_WRITES === "true";
const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH ??
  `${process.env.HOME ?? "/tmp"}/.mcp-local-dev-toolbox/audit.jsonl`;

// ---------------------------------------------------------------------------
// Build tool registry
// ---------------------------------------------------------------------------

/**
 * All tool modules are collected here. To disable a category, remove it from
 * this array. Order does not matter — tools are registered by name.
 */
const allToolModules: ToolDefinition[] = [
  ...filesystemTools,
  ...gitTools,
  ...testTools,
  ...searchTools,
];

const toolRegistry = new Map<string, ToolDefinition>(
  allToolModules.map((t) => [t.name, t])
);

// ---------------------------------------------------------------------------
// Safety checker
// ---------------------------------------------------------------------------

const safety = new SafetyChecker({
  workspaceRoot: WORKSPACE_ROOT,
  allowWrites: ALLOW_WRITES,
  auditLogPath: AUDIT_LOG_PATH,
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "mcp-local-dev-toolbox",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * ListTools handler — returns the full tool inventory to the client.
 * The client (Claude, Cursor, etc.) uses this to know what tools are available.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = allToolModules.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  return { tools };
});

/**
 * CallTool handler — dispatches a tool call through the safety checker,
 * executes the handler, and returns the result.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const toolDef = toolRegistry.get(name);
  if (!toolDef) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Run safety pre-check before executing anything
  const safetyResult = await safety.preCheck(name, args ?? {});
  if (!safetyResult.allowed) {
    await safety.auditLog({
      tool: name,
      args: args ?? {},
      allowed: false,
      reason: safetyResult.reason,
    });
    return {
      content: [
        {
          type: "text",
          text: `[BLOCKED] ${safetyResult.reason}`,
        },
      ],
      isError: true,
    };
  }

  let result: unknown;
  let errorOccurred = false;

  try {
    result = await toolDef.handler(args ?? {}, {
      workspaceRoot: WORKSPACE_ROOT,
      allowWrites: ALLOW_WRITES,
    });
  } catch (err) {
    errorOccurred = true;
    result = { error: err instanceof Error ? err.message : String(err) };
  }

  // Always write to audit log
  await safety.auditLog({
    tool: name,
    args: args ?? {},
    allowed: true,
    result,
    errorOccurred,
  });

  if (errorOccurred) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${(result as { error: string }).error}`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();

  console.error(
    `[mcp-local-dev-toolbox] Starting server\n` +
      `  workspace: ${WORKSPACE_ROOT}\n` +
      `  writes:    ${ALLOW_WRITES ? "ENABLED" : "disabled"}\n` +
      `  audit log: ${AUDIT_LOG_PATH}\n` +
      `  tools:     ${allToolModules.length} registered`
  );

  await server.connect(transport);
}

main().catch((err) => {
  console.error("[mcp-local-dev-toolbox] Fatal error:", err);
  process.exit(1);
});
