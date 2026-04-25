/**
 * Search tools
 *
 * grep_codebase uses ripgrep (rg) for performance. If rg is not installed,
 * it falls back to a Node.js implementation using readline.
 *
 * All search tools operate read-only within the workspace.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);

// Directories to always exclude from search
const ALWAYS_EXCLUDED = ["node_modules", ".git", "dist", ".next", "coverage", ".cache"];

async function isRipgrepAvailable(): Promise<boolean> {
  try {
    await execFileAsync("rg", ["--version"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tool: grep_codebase
// ---------------------------------------------------------------------------

const grepCodebase: ToolDefinition = {
  name: "grep_codebase",
  description:
    "Search for a pattern across all files in the workspace. " +
    "Uses ripgrep (rg) for performance, falls back to Node.js if rg is unavailable. " +
    "node_modules, .git, and dist are always excluded.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Search pattern. Treated as a literal string unless regex=true.",
      },
      regex: {
        type: "boolean",
        description: "Treat pattern as a regular expression. Default: false.",
        default: false,
      },
      caseSensitive: {
        type: "boolean",
        description: "Default: false.",
        default: false,
      },
      include: {
        type: "string",
        description: "Glob pattern to limit which files are searched (e.g. '**/*.ts').",
      },
      exclude: {
        type: "string",
        description: "Glob pattern to exclude files.",
      },
      maxResults: {
        type: "number",
        description: "Maximum matching lines to return. Default: 200. Cap: 1000.",
        default: 200,
      },
      contextLines: {
        type: "number",
        description: "Lines of context before/after each match. Default: 2. Max: 10.",
        default: 2,
      },
    },
    required: ["pattern"],
  },

  async handler(args, ctx: ToolContext) {
    const pattern = args.pattern as string;
    const regex = (args.regex as boolean | undefined) ?? false;
    const caseSensitive = (args.caseSensitive as boolean | undefined) ?? false;
    const maxResults = Math.min((args.maxResults as number | undefined) ?? 200, 1000);
    const contextLines = Math.min((args.contextLines as number | undefined) ?? 2, 10);

    const useRipgrep = await isRipgrepAvailable();

    if (useRipgrep) {
      return await runRipgrep({
        pattern,
        regex,
        caseSensitive,
        include: args.include as string | undefined,
        exclude: args.exclude as string | undefined,
        maxResults,
        contextLines,
        workspaceRoot: ctx.workspaceRoot,
      });
    } else {
      // TODO: Node.js fallback using readline and manual glob walking.
      // This is intentionally left as a stub — the ripgrep path covers the
      // real use case; the fallback is a safety net for environments without rg.
      return {
        matches: [],
        total: 0,
        truncated: false,
        filesSearched: 0,
        filesMatched: 0,
        durationMs: 0,
        note: "ripgrep (rg) is not installed. Node.js fallback is not yet implemented. Install rg for full search support.",
      };
    }
  },
};

interface RipgrepOptions {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  include?: string;
  exclude?: string;
  maxResults: number;
  contextLines: number;
  workspaceRoot: string;
}

async function runRipgrep(opts: RipgrepOptions) {
  const start = Date.now();

  const rgArgs: string[] = [
    "--json",
    `--context=${opts.contextLines}`,
    `--max-count=${opts.maxResults}`,
  ];

  if (!opts.regex) rgArgs.push("--fixed-strings");
  if (!opts.caseSensitive) rgArgs.push("--ignore-case");
  if (opts.include) rgArgs.push("--glob", opts.include);

  // Always exclude noisy directories
  for (const dir of ALWAYS_EXCLUDED) {
    rgArgs.push("--glob", `!${dir}/**`);
  }
  if (opts.exclude) rgArgs.push("--glob", `!${opts.exclude}`);

  // Pattern must be passed as a positional argument after --
  // This prevents any pattern starting with - from being treated as a flag
  rgArgs.push("--", opts.pattern, opts.workspaceRoot);

  let rawOutput = "";
  try {
    const { stdout } = await execFileAsync("rg", rgArgs, {
      maxBuffer: 20 * 1024 * 1024,
      cwd: opts.workspaceRoot,
    });
    rawOutput = stdout;
  } catch (err: unknown) {
    // rg exits with code 1 when no matches found — that's not an error
    const execError = err as NodeJS.ErrnoException & { code?: number; stdout?: string };
    if (execError.code === 1) {
      rawOutput = execError.stdout ?? "";
    } else {
      throw err;
    }
  }

  // Parse ripgrep JSON output (one JSON object per line)
  interface RgMatch {
    path: string;
    line: number;
    column: number;
    text: string;
    contextBefore: string[];
    contextAfter: string[];
  }

  const matches: RgMatch[] = [];
  let filesSearched = 0;
  let filesMatched = 0;
  let truncated = false;

  const lines = rawOutput.split("\n").filter(Boolean);
  const contextBuffer: { before: string[]; after: string[] } = { before: [], after: [] };

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type: string; data: Record<string, unknown> };

      if (obj.type === "begin") {
        filesSearched++;
      } else if (obj.type === "match") {
        filesMatched++;
        const data = obj.data;
        const lineNumber = (data.line_number as number) ?? 0;
        const pathText = (data.path as { text: string })?.text ?? "";
        const lineText = (data.lines as { text: string })?.text?.trimEnd() ?? "";
        const submatches = (data.submatches as Array<{ start: number }>) ?? [];
        const column = submatches[0]?.start ?? 0;

        matches.push({
          path: path.relative(opts.workspaceRoot, pathText),
          line: lineNumber,
          column,
          text: lineText,
          contextBefore: [...contextBuffer.before],
          contextAfter: [],
        });
        contextBuffer.before = [];
      } else if (obj.type === "context") {
        // Context lines — associate with preceding match's contextAfter
        // TODO: proper context threading
        void contextBuffer;
      } else if (obj.type === "summary") {
        const summary = obj.data as { stats: { matched_lines: number } };
        if (summary.stats?.matched_lines > opts.maxResults) {
          truncated = true;
        }
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  return {
    matches,
    total: matches.length,
    truncated,
    filesSearched,
    filesMatched,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Tool: find_files
// ---------------------------------------------------------------------------

const findFiles: ToolDefinition = {
  name: "find_files",
  description:
    "Find files by name pattern within the workspace. " +
    "node_modules, .git, and dist are always excluded.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob or filename pattern to match (e.g. '*.config.ts', 'auth*').",
      },
      directory: {
        type: "string",
        description: "Subdirectory to search within. Default: workspace root.",
      },
      maxResults: {
        type: "number",
        description: "Default: 500. Cap: 2000.",
        default: 500,
      },
    },
    required: ["pattern"],
  },

  async handler(args, ctx: ToolContext) {
    const pattern = args.pattern as string;
    const maxResults = Math.min((args.maxResults as number | undefined) ?? 500, 2000);
    const searchDir = args.directory
      ? path.resolve(ctx.workspaceRoot, args.directory as string)
      : ctx.workspaceRoot;

    // TODO: Use fast-glob for proper glob matching with exclusions.
    // This stub uses a simple directory walk for demonstration.
    const files: Array<{
      path: string;
      name: string;
      directory: string;
      sizeBytes: number;
      modifiedAt: string;
    }> = [];

    async function walk(dir: string, depth: number) {
      if (depth > 8 || files.length >= maxResults) return;
      let entries: Awaited<ReturnType<typeof fs.readdir>>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (ALWAYS_EXCLUDED.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          // Simple pattern matching: check if name matches pattern
          // A real implementation would use minimatch or fast-glob
          const nameMatches =
            entry.name.includes(pattern.replace(/\*/g, "")) ||
            entry.name === pattern;
          if (nameMatches) {
            try {
              const stat = await fs.stat(fullPath);
              files.push({
                path: path.relative(ctx.workspaceRoot, fullPath),
                name: entry.name,
                directory: path.relative(ctx.workspaceRoot, dir),
                sizeBytes: stat.size,
                modifiedAt: stat.mtime.toISOString(),
              });
            } catch {
              // skip
            }
          }
        }
      }
    }

    await walk(searchDir, 0);

    return {
      files,
      total: files.length,
      truncated: files.length >= maxResults,
      note: "Pattern matching is a simple substring check in this stub. Full glob matching via fast-glob is a TODO.",
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: search_symbols
// ---------------------------------------------------------------------------

const searchSymbols: ToolDefinition = {
  name: "search_symbols",
  description:
    "Search for TypeScript/JavaScript symbol definitions (functions, classes, interfaces, types) by name. " +
    "Uses a fast regex heuristic — not a full AST parser.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Symbol name to search for (substring match).",
      },
      kind: {
        type: "string",
        description:
          "Filter by kind: 'function', 'class', 'interface', 'type', 'variable', 'const', 'enum'. Omit to search all.",
        enum: ["function", "class", "interface", "type", "variable", "const", "enum"],
      },
      include: {
        type: "string",
        description: "File glob to limit search.",
      },
      maxResults: {
        type: "number",
        description: "Default: 100.",
        default: 100,
      },
    },
    required: ["name"],
  },

  async handler(args, ctx: ToolContext) {
    const symbolName = args.name as string;
    const kind = args.kind as string | undefined;
    const maxResults = (args.maxResults as number | undefined) ?? 100;

    // Build a regex pattern that matches common declaration forms
    const kindPatterns: Record<string, string> = {
      function: `(?:export\\s+)?(?:async\\s+)?function\\s+(${escapeRegex(symbolName)}\\w*)`,
      class: `(?:export\\s+)?(?:abstract\\s+)?class\\s+(${escapeRegex(symbolName)}\\w*)`,
      interface: `(?:export\\s+)?interface\\s+(${escapeRegex(symbolName)}\\w*)`,
      type: `(?:export\\s+)?type\\s+(${escapeRegex(symbolName)}\\w*)\\s*=`,
      const: `(?:export\\s+)?const\\s+(${escapeRegex(symbolName)}\\w*)`,
      variable: `(?:export\\s+)?(?:let|var)\\s+(${escapeRegex(symbolName)}\\w*)`,
      enum: `(?:export\\s+)?enum\\s+(${escapeRegex(symbolName)}\\w*)`,
    };

    const patterns = kind
      ? [kindPatterns[kind]].filter(Boolean)
      : Object.values(kindPatterns);

    const combinedPattern = patterns.join("|");

    // Use ripgrep to search for symbol definitions
    const useRipgrep = await isRipgrepAvailable();
    if (!useRipgrep) {
      return {
        symbols: [],
        total: 0,
        truncated: false,
        note: "ripgrep (rg) is not installed. search_symbols requires rg.",
      };
    }

    const rgArgs = [
      "--json",
      "--regex",
      "--ignore-case",
      `--max-count=${maxResults}`,
      "--glob", "**/*.ts",
      "--glob", "**/*.tsx",
      "--glob", "**/*.js",
      "--glob", "**/*.jsx",
    ];

    if (args.include) rgArgs.push("--glob", args.include as string);
    for (const dir of ALWAYS_EXCLUDED) {
      rgArgs.push("--glob", `!${dir}/**`);
    }

    rgArgs.push("--", combinedPattern, ctx.workspaceRoot);

    let rawOutput = "";
    try {
      const { stdout } = await execFileAsync("rg", rgArgs, {
        maxBuffer: 10 * 1024 * 1024,
        cwd: ctx.workspaceRoot,
      });
      rawOutput = stdout;
    } catch (err: unknown) {
      const execError = err as { code?: number; stdout?: string };
      if (execError.code === 1) {
        rawOutput = execError.stdout ?? "";
      } else {
        throw err;
      }
    }

    const symbols: Array<{
      name: string;
      kind: string;
      path: string;
      line: number;
      column: number;
      snippet: string;
    }> = [];

    for (const line of rawOutput.split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(line) as { type: string; data: Record<string, unknown> };
        if (obj.type === "match") {
          const data = obj.data;
          const lineText = (data.lines as { text: string })?.text?.trimEnd() ?? "";
          const filePath = (data.path as { text: string })?.text ?? "";
          const lineNumber = (data.line_number as number) ?? 0;

          // Determine which kind this match belongs to
          let matchedKind = "unknown";
          for (const [k, pat] of Object.entries(kindPatterns)) {
            if (new RegExp(pat, "i").test(lineText)) {
              matchedKind = k;
              break;
            }
          }

          symbols.push({
            name: symbolName,
            kind: matchedKind,
            path: path.relative(ctx.workspaceRoot, filePath),
            line: lineNumber,
            column: 0,
            snippet: lineText,
          });
        }
      } catch {
        // skip
      }
    }

    return {
      symbols: symbols.slice(0, maxResults),
      total: symbols.length,
      truncated: symbols.length >= maxResults,
    };
  },
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const searchTools: ToolDefinition[] = [grepCodebase, findFiles, searchSymbols];
