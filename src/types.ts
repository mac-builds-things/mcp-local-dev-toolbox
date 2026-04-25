/**
 * Shared types for tool definitions and the tool execution context.
 */

export interface ToolContext {
  workspaceRoot: string;
  allowWrites: boolean;
}

/**
 * A ToolDefinition is the complete specification for a single MCP tool:
 * its name, description, JSON Schema for inputs, and the handler function.
 */
export interface ToolDefinition {
  /** The tool name as exposed to MCP clients (snake_case). */
  name: string;

  /** Human-readable description shown to the AI agent. Be precise. */
  description: string;

  /**
   * JSON Schema (draft-07 compatible) for the tool's input parameters.
   * The MCP SDK validates inputs against this schema before calling the handler.
   */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };

  /**
   * The actual implementation. Receives validated args and a context object.
   * Should throw on error (the server wraps this in try/catch).
   */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  args: Record<string, unknown>;
  allowed: boolean;
  reason?: string;
  result?: unknown;
  errorOccurred?: boolean;
}
