/**
 * Test runner tools
 *
 * Detects the test runner from package.json (Jest, Vitest, Mocha) and runs
 * tests by constructing a safe argument array — never a shell string.
 *
 * Watch mode is deliberately not supported: an MCP tool call must complete
 * and return a result. Persistent watchers cannot be managed inside the
 * MCP request/response model.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------

type TestRunner = "jest" | "vitest" | "mocha" | "unknown";

async function detectRunner(workspaceRoot: string): Promise<TestRunner> {
  try {
    const pkgRaw = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;

    const deps = {
      ...((pkg.dependencies ?? {}) as Record<string, string>),
      ...((pkg.devDependencies ?? {}) as Record<string, string>),
    };

    if (deps["vitest"]) return "vitest";
    if (deps["jest"] || deps["@jest/core"]) return "jest";
    if (deps["mocha"]) return "mocha";
  } catch {
    // package.json not found or not parseable
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Safe runner execution
// ---------------------------------------------------------------------------

interface RunResult {
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

function buildRunnerArgs(
  runner: TestRunner,
  pattern?: string,
  bail?: boolean,
  coverage?: boolean
): { command: string; args: string[] } {
  switch (runner) {
    case "vitest": {
      const args = ["run"];
      if (coverage) args.push("--coverage");
      if (bail) args.push("--bail");
      if (pattern) args.push(pattern);
      return { command: "npx", args: ["vitest", ...args] };
    }
    case "jest": {
      const args = ["--no-coverage"];
      if (coverage) {
        // Remove --no-coverage and add --coverage
        args.length = 0;
        args.push("--coverage");
      }
      if (bail) args.push("--bail");
      if (pattern) args.push("--testPathPattern", pattern);
      return { command: "npx", args: ["jest", ...args] };
    }
    case "mocha": {
      const args: string[] = [];
      if (pattern) args.push("--grep", pattern);
      if (bail) args.push("--bail");
      return { command: "npx", args: ["mocha", ...args] };
    }
    default:
      // Fall back to npm test — safest option when runner is unknown
      return { command: "npm", args: ["test"] };
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  maxRunMs: number
): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let output = "";
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      shell: false, // Never use shell:true — prevents injection
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, maxRunMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        output,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tool: run_tests
// ---------------------------------------------------------------------------

const runTests: ToolDefinition = {
  name: "run_tests",
  description:
    "Run the project's test suite or a subset of it. " +
    "Auto-detects Jest, Vitest, or Mocha from package.json. " +
    "Watch mode is not supported.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "File glob or test name pattern to filter which tests run. " +
          "Passed to the runner's --testPathPattern or equivalent.",
      },
      bail: {
        type: "boolean",
        description: "Stop after the first failure. Default: false.",
        default: false,
      },
      maxRunMs: {
        type: "number",
        description:
          "Kill the test process after this many milliseconds. Default: 120000 (2 min). Cap: 300000.",
        default: 120_000,
      },
    },
    required: [],
  },

  async handler(args, ctx: ToolContext) {
    const maxRunMs = Math.min((args.maxRunMs as number | undefined) ?? 120_000, 300_000);
    const bail = (args.bail as boolean | undefined) ?? false;
    const pattern = args.pattern as string | undefined;

    const runner = await detectRunner(ctx.workspaceRoot);
    const { command, args: runnerArgs } = buildRunnerArgs(runner, pattern, bail, false);

    const result = await runProcess(command, runnerArgs, ctx.workspaceRoot, maxRunMs);

    // TODO: Parse runner-specific output to populate structured failures[].
    // Jest and Vitest emit JSON reporter output; parsing those would give us
    // per-test pass/fail/skip counts and structured failure messages.

    return {
      passed: null, // TODO: parse from output
      failed: null,
      skipped: null,
      total: null,
      durationMs: result.durationMs,
      output: result.output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      failures: [], // TODO: structured parse
      runner,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: get_coverage
// ---------------------------------------------------------------------------

const getCoverage: ToolDefinition = {
  name: "get_coverage",
  description:
    "Run the test suite with coverage enabled and return a coverage summary.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Limit to specific files/tests.",
      },
      maxRunMs: {
        type: "number",
        description: "Default: 180000 (3 min). Cap: 300000.",
        default: 180_000,
      },
    },
    required: [],
  },

  async handler(args, ctx: ToolContext) {
    const maxRunMs = Math.min((args.maxRunMs as number | undefined) ?? 180_000, 300_000);
    const pattern = args.pattern as string | undefined;

    const runner = await detectRunner(ctx.workspaceRoot);
    const { command, args: runnerArgs } = buildRunnerArgs(runner, pattern, false, true);

    const result = await runProcess(command, runnerArgs, ctx.workspaceRoot, maxRunMs);

    // TODO: Parse JSON coverage output (Istanbul/c8 format) to produce
    // the structured summary documented in TOOLS.md.
    return {
      summary: null, // TODO
      files: [],     // TODO
      durationMs: result.durationMs,
      output: result.output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: list_test_files
// ---------------------------------------------------------------------------

const listTestFiles: ToolDefinition = {
  name: "list_test_files",
  description: "List all test files in the workspace without running them.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Additional glob pattern to filter results.",
      },
    },
    required: [],
  },

  async handler(args, ctx: ToolContext) {
    // Common test file patterns — we scan for these without spawning the runner
    const testGlobs = [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.test.js",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.spec.js",
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.js",
    ];

    // TODO: Use fast-glob with the patterns above.
    // For now, return a stub response.
    void args;
    void testGlobs;

    return {
      files: [],
      total: 0,
      note: "list_test_files is a stub. Full implementation uses fast-glob with common test file patterns.",
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const testTools: ToolDefinition[] = [runTests, getCoverage, listTestFiles];
