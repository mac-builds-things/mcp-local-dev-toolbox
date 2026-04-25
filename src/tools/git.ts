/**
 * Git tools
 *
 * All git tools are read-only. They use simple-git under the hood, which
 * executes git with argument arrays — no shell interpolation.
 *
 * NOTE: simple-git is listed in package.json but this module currently uses
 * child_process.execFile stubs to avoid requiring the install step. A real
 * implementation should use the simple-git API directly.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Run a git command in the workspace. Arguments are passed as an array
 * to execFile — never interpolated into a shell string.
 */
async function runGit(args: string[], workspaceRoot: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
  // git sometimes writes informational output to stderr; include it
  return stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
}

// ---------------------------------------------------------------------------
// Tool: git_status
// ---------------------------------------------------------------------------

const gitStatus: ToolDefinition = {
  name: "git_status",
  description:
    "Show the working tree status: branch info, staged changes, unstaged changes, and untracked files.",
  inputSchema: {
    type: "object",
    properties: {
      short: {
        type: "boolean",
        description: "Return short-format status. Default: false.",
        default: false,
      },
    },
    required: [],
  },

  async handler(args, ctx: ToolContext) {
    const short = (args.short as boolean | undefined) ?? false;

    // Get porcelain v2 output for structured parsing
    const porcelainOutput = await runGit(
      ["status", "--porcelain=v2", "--branch"],
      ctx.workspaceRoot
    );

    if (short) {
      const shortOutput = await runGit(["status", "--short", "--branch"], ctx.workspaceRoot);
      return { raw: shortOutput };
    }

    // TODO: Parse porcelain v2 format into the structured response shape
    // documented in TOOLS.md. For now, return the raw output.
    return {
      raw: porcelainOutput,
      note: "Structured parsing (branch, ahead/behind, staged[], unstaged[], untracked[]) is a TODO. Raw porcelain v2 output is included above.",
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: git_diff
// ---------------------------------------------------------------------------

const gitDiff: ToolDefinition = {
  name: "git_diff",
  description:
    "Show changes between commits, the index, or working tree. " +
    "Returns a unified diff. Output is truncated at maxLines (default 2000).",
  inputSchema: {
    type: "object",
    properties: {
      staged: {
        type: "boolean",
        description: "Show staged (index) diff instead of working tree diff. Default: false.",
        default: false,
      },
      from: {
        type: "string",
        description: "Starting ref (commit hash, branch, tag).",
      },
      to: {
        type: "string",
        description: "Ending ref. Defaults to HEAD when from is set.",
      },
      path: {
        type: "string",
        description: "Limit diff to this file or directory.",
      },
      contextLines: {
        type: "number",
        description: "Lines of context around each change. Default: 3.",
        default: 3,
      },
      maxLines: {
        type: "number",
        description: "Truncate diff output after this many lines. Default: 2000. Cap: 5000.",
        default: 2000,
      },
    },
    required: [],
  },

  async handler(args, ctx: ToolContext) {
    const staged = (args.staged as boolean | undefined) ?? false;
    const contextLines = (args.contextLines as number | undefined) ?? 3;
    const maxLines = Math.min((args.maxLines as number | undefined) ?? 2000, 5000);

    const gitArgs: string[] = ["diff", `--unified=${contextLines}`];

    if (staged) gitArgs.push("--staged");
    if (args.from && args.to) {
      gitArgs.push(`${args.from}..${args.to}`);
    } else if (args.from) {
      gitArgs.push(args.from as string);
    }
    if (args.path) {
      gitArgs.push("--", args.path as string);
    }

    const raw = await runGit(gitArgs, ctx.workspaceRoot);
    const lines = raw.split("\n");
    const truncated = lines.length > maxLines;

    return {
      diff: lines.slice(0, maxLines).join("\n"),
      truncated,
      // TODO: parse --stat output separately to populate filesChanged/insertions/deletions
      filesChanged: null,
      insertions: null,
      deletions: null,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: git_log
// ---------------------------------------------------------------------------

const gitLog: ToolDefinition = {
  name: "git_log",
  description: "Show commit history with author, date, and subject.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum commits to return. Default: 20. Max: 100.",
        default: 20,
      },
      branch: {
        type: "string",
        description: "Branch or ref to show. Default: current branch (HEAD).",
      },
      path: {
        type: "string",
        description: "Filter to commits that touched this path.",
      },
      author: {
        type: "string",
        description: "Filter by author name or email (substring).",
      },
      since: {
        type: "string",
        description: "Only commits after this date (ISO 8601 or git date).",
      },
      until: {
        type: "string",
        description: "Only commits before this date.",
      },
    },
    required: [],
  },

  async handler(args, ctx: ToolContext) {
    const limit = Math.min((args.limit as number | undefined) ?? 20, 100);

    const gitArgs: string[] = [
      "log",
      `--max-count=${limit}`,
      // Use a null-byte-separated format for safe parsing
      "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b%x1E",
    ];

    if (args.branch) gitArgs.push(args.branch as string);
    if (args.author) gitArgs.push(`--author=${args.author}`);
    if (args.since) gitArgs.push(`--since=${args.since}`);
    if (args.until) gitArgs.push(`--until=${args.until}`);
    if (args.path) {
      gitArgs.push("--", args.path as string);
    }

    const raw = await runGit(gitArgs, ctx.workspaceRoot);

    // Parse the record-separator-delimited output
    const commits = raw
      .split("\x1E")
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash, shortHash, author, email, date, subject, ...bodyParts] =
          record.split("\x00");
        return {
          hash: hash?.trim(),
          shortHash: shortHash?.trim(),
          author: author?.trim(),
          email: email?.trim(),
          date: date?.trim(),
          subject: subject?.trim(),
          body: bodyParts.join("").trim(),
        };
      });

    return { commits, total: commits.length };
  },
};

// ---------------------------------------------------------------------------
// Tool: git_branch
// ---------------------------------------------------------------------------

const gitBranch: ToolDefinition = {
  name: "git_branch",
  description: "List branches in the repository.",
  inputSchema: {
    type: "object",
    properties: {
      all: {
        type: "boolean",
        description: "Include remote-tracking branches. Default: false.",
        default: false,
      },
      verbose: {
        type: "boolean",
        description: "Include last commit info per branch. Default: false.",
        default: false,
      },
    },
    required: [],
  },

  async handler(args, ctx: ToolContext) {
    const all = (args.all as boolean | undefined) ?? false;
    const verbose = (args.verbose as boolean | undefined) ?? false;

    const gitArgs = ["branch", "--format=%(refname:short)%09%(HEAD)%09%(objectname:short)%09%(subject)%09%(committerdate:iso-strict)"];
    if (all) gitArgs.push("--all");
    if (verbose) gitArgs.push("-v");

    const raw = await runGit(gitArgs, ctx.workspaceRoot);

    const branches = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, isCurrent, hash, subject, date] = line.split("\t");
        return {
          name: name?.trim(),
          isRemote: name?.startsWith("remotes/") ?? false,
          isCurrent: isCurrent?.trim() === "*",
          lastCommitHash: hash?.trim() || null,
          lastCommitSubject: subject?.trim() || null,
          lastCommitDate: date?.trim() || null,
        };
      });

    const current = branches.find((b) => b.isCurrent)?.name ?? "";
    return { current, branches };
  },
};

// ---------------------------------------------------------------------------
// Tool: git_show
// ---------------------------------------------------------------------------

const gitShow: ToolDefinition = {
  name: "git_show",
  description:
    "Show the contents of a specific commit, or a file as it existed at a given ref.",
  inputSchema: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "Commit hash, tag, or branch name.",
      },
      path: {
        type: "string",
        description:
          "If provided, show the file at this path at the given ref rather than the full commit diff.",
      },
    },
    required: ["ref"],
  },

  async handler(args, ctx: ToolContext) {
    const ref = args.ref as string;

    if (args.path) {
      // Show file contents at ref — safe: no path is written, only read
      const content = await runGit(
        ["show", `${ref}:${args.path}`],
        ctx.workspaceRoot
      );
      return {
        ref,
        path: args.path,
        content,
        sizeBytes: Buffer.byteLength(content),
      };
    }

    // Show full commit
    const raw = await runGit(
      ["show", "--format=%H%n%an%n%aI%n%s%n%b", "--", ref],
      ctx.workspaceRoot
    );
    const lines = raw.split("\n");
    const [hash, author, date, subject, ...rest] = lines;
    // Remaining lines after the header are the diff
    const diff = rest.join("\n");

    return { hash, author, date, subject, body: "", diff };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const gitTools: ToolDefinition[] = [
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitShow,
];
