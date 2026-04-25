/**
 * SafetyChecker
 *
 * Runs before every tool call. Enforces:
 *   1. Workspace path confinement — all path arguments must resolve inside WORKSPACE_ROOT
 *   2. Operation allowlist — write operations require ALLOW_WRITES=true
 *   3. Blocked patterns — certain paths/names are never writable (e.g. .git/, *.env)
 *   4. Audit logging — every call (allowed or blocked) is written to an audit log
 *
 * The safety checker is intentionally simple and explicit. It does not attempt
 * to be a comprehensive security sandbox — it is a developer ergonomics tool
 * that prevents common agent mistakes (writing outside the project, clobbering
 * sensitive files) and provides an audit trail.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SafetyConfig {
  workspaceRoot: string;
  allowWrites: boolean;
  auditLogPath: string;

  /**
   * Additional filename patterns that are never writable.
   * Evaluated against the basename of the resolved path.
   * Supports simple glob-style wildcards (* only).
   */
  blockedWritePatterns?: string[];
}

const DEFAULT_BLOCKED_WRITE_PATTERNS = [
  "*.env",
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*secret*",
  "*password*",
  "*credential*",
  ".npmrc",
  ".netrc",
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PreCheckResult {
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// SafetyChecker
// ---------------------------------------------------------------------------

export class SafetyChecker {
  private readonly config: Required<SafetyConfig>;
  private auditLogReady = false;

  constructor(config: SafetyConfig) {
    this.config = {
      ...config,
      blockedWritePatterns: [
        ...DEFAULT_BLOCKED_WRITE_PATTERNS,
        ...(config.blockedWritePatterns ?? []),
      ],
    };
  }

  /**
   * Run all pre-call safety checks for a tool invocation.
   * Returns { allowed: true } if the call should proceed,
   * or { allowed: false, reason } if it should be blocked.
   */
  async preCheck(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<PreCheckResult> {
    // 1. Check write permission for write tools
    if (toolName === "write_file" && !this.config.allowWrites) {
      return {
        allowed: false,
        reason:
          "Write operations are disabled. Restart the server with ALLOW_WRITES=true to enable file writes.",
      };
    }

    // 2. Check path arguments against workspace root
    const pathCheck = this.checkPathArgs(args);
    if (!pathCheck.allowed) return pathCheck;

    // 3. Check blocked write patterns for write_file
    if (toolName === "write_file" && args.path) {
      const resolvedPath = this.resolvePath(args.path as string);
      const basename = path.basename(resolvedPath);

      for (const pattern of this.config.blockedWritePatterns) {
        if (matchesSimpleGlob(basename, pattern)) {
          return {
            allowed: false,
            reason: `Writing to "${basename}" is blocked by the blocked-write-patterns rule (matched: "${pattern}"). ` +
              `This prevents accidental writes to sensitive files.`,
          };
        }
      }

      // Always block writes to .git/
      if (
        resolvedPath.includes(`${path.sep}.git${path.sep}`) ||
        resolvedPath.endsWith(`${path.sep}.git`)
      ) {
        return {
          allowed: false,
          reason: "Writing to .git/ is never allowed.",
        };
      }
    }

    return { allowed: true, reason: "OK" };
  }

  /**
   * Check all string arguments named 'path' (or ending in 'Path') against
   * the workspace root. This is a defense-in-depth check — individual tool
   * handlers also validate paths, but this centralizes the enforcement.
   */
  private checkPathArgs(args: Record<string, unknown>): PreCheckResult {
    for (const [key, value] of Object.entries(args)) {
      if (
        typeof value === "string" &&
        (key === "path" || key.toLowerCase().endsWith("path"))
      ) {
        const resolved = this.resolvePath(value);
        const workspaceWithSep = this.config.workspaceRoot + path.sep;

        if (
          resolved !== this.config.workspaceRoot &&
          !resolved.startsWith(workspaceWithSep)
        ) {
          return {
            allowed: false,
            reason:
              `Path argument "${key}" resolves to "${resolved}" which is outside ` +
              `the workspace root "${this.config.workspaceRoot}". ` +
              `Only paths within the workspace are accessible.`,
          };
        }
      }
    }
    return { allowed: true, reason: "OK" };
  }

  private resolvePath(userPath: string): string {
    return path.isAbsolute(userPath)
      ? path.normalize(userPath)
      : path.resolve(this.config.workspaceRoot, userPath);
  }

  // ---------------------------------------------------------------------------
  // Audit logging
  // ---------------------------------------------------------------------------

  /**
   * Append an entry to the audit log.
   * The log is a newline-delimited JSON file (JSONL).
   * Log directory is created on first write.
   */
  async auditLog(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const line = JSON.stringify(fullEntry) + "\n";

    try {
      if (!this.auditLogReady) {
        await fs.mkdir(path.dirname(this.config.auditLogPath), { recursive: true });
        this.auditLogReady = true;
      }
      await fs.appendFile(this.config.auditLogPath, line, "utf-8");
    } catch (err) {
      // Audit log failure is non-fatal — log to stderr but don't break the tool call
      console.error("[mcp-local-dev-toolbox] Audit log write failed:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Utility: read recent audit log entries (for debugging / review)
  // ---------------------------------------------------------------------------

  /**
   * Read the last N entries from the audit log.
   * Useful for implementing a future "audit_log" MCP tool.
   */
  async readRecentAuditEntries(limit = 50): Promise<AuditEntry[]> {
    try {
      const raw = await fs.readFile(this.config.auditLogPath, "utf-8");
      const entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEntry => e !== null);

      return entries.slice(-limit);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Very simple glob match supporting only * as a wildcard.
 * For production use, replace with minimatch or picomatch.
 */
function matchesSimpleGlob(str: string, pattern: string): boolean {
  // Escape regex special chars except *
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`, "i").test(str);
}
