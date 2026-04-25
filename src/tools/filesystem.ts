/**
 * Filesystem tools
 *
 * Provides read_file, list_dir, write_file, file_exists, and get_file_info.
 * All paths are resolved against WORKSPACE_ROOT and workspace-checked before
 * any I/O occurs (the SafetyChecker in server.ts handles this pre-flight;
 * handlers here also re-validate as a defense-in-depth measure).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path against the workspace root.
 * Throws if the resolved path escapes the workspace.
 */
function resolveSafe(userPath: string, workspaceRoot: string): string {
  const resolved = path.isAbsolute(userPath)
    ? path.normalize(userPath)
    : path.resolve(workspaceRoot, userPath);

  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new Error(
      `Path "${userPath}" resolves to "${resolved}" which is outside the workspace root "${workspaceRoot}".`
    );
  }

  return resolved;
}

const ALWAYS_EXCLUDED = new Set(["node_modules", ".git", "dist", ".next", "coverage"]);

// ---------------------------------------------------------------------------
// Tool: read_file
// ---------------------------------------------------------------------------

const readFile: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file within the workspace. " +
    "Returns the file content as a string. " +
    "Large files are truncated at maxBytes (default 500 KB).",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, relative to workspace root or absolute.",
      },
      encoding: {
        type: "string",
        description: "File encoding. Default: utf-8.",
        default: "utf-8",
      },
      maxBytes: {
        type: "number",
        description: "Truncate after this many bytes. Default: 500000.",
        default: 500_000,
      },
    },
    required: ["path"],
  },

  async handler(args, ctx: ToolContext) {
    const filePath = resolveSafe(args.path as string, ctx.workspaceRoot);
    const maxBytes = (args.maxBytes as number | undefined) ?? 500_000;

    const stat = await fs.stat(filePath);
    const sizeBytes = stat.size;
    const truncated = sizeBytes > maxBytes;

    // Read up to maxBytes using a file handle to avoid loading huge files
    const fd = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(sizeBytes, maxBytes));
      await fd.read(buffer, 0, buffer.length, 0);
      const content = buffer.toString((args.encoding as BufferEncoding | undefined) ?? "utf-8");
      return { content, truncated, sizeBytes, path: filePath };
    } finally {
      await fd.close();
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: list_dir
// ---------------------------------------------------------------------------

const listDir: ToolDefinition = {
  name: "list_dir",
  description:
    "List the contents of a directory within the workspace. " +
    "node_modules, .git, dist, .next, and coverage are always excluded.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path, relative to workspace root or absolute.",
      },
      recursive: {
        type: "boolean",
        description: "Recursively list all contents. Default: false.",
        default: false,
      },
      maxDepth: {
        type: "number",
        description: "Maximum recursion depth when recursive=true. Default: 5. Cap: 10.",
        default: 5,
      },
      include: {
        type: "string",
        description: "Glob pattern to include (e.g. '**/*.ts').",
      },
      exclude: {
        type: "string",
        description: "Glob pattern to exclude.",
      },
    },
    required: ["path"],
  },

  async handler(args, ctx: ToolContext) {
    const dirPath = resolveSafe(args.path as string, ctx.workspaceRoot);
    const recursive = (args.recursive as boolean | undefined) ?? false;
    const maxDepth = Math.min((args.maxDepth as number | undefined) ?? 5, 10);

    // TODO: Implement full recursive listing with glob filtering.
    // Real implementation would use fast-glob with the include/exclude patterns.
    // For now, return a flat listing of the immediate directory.

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const filtered = entries.filter((e) => !ALWAYS_EXCLUDED.has(e.name));

    const result = await Promise.all(
      filtered.map(async (entry) => {
        const entryPath = path.join(dirPath, entry.name);
        let sizeBytes: number | null = null;
        let modifiedAt = "";

        try {
          const stat = await fs.stat(entryPath);
          sizeBytes = entry.isFile() ? stat.size : null;
          modifiedAt = stat.mtime.toISOString();
        } catch {
          // stat may fail on broken symlinks
        }

        return {
          name: entry.name,
          path: entryPath,
          type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file",
          sizeBytes,
          modifiedAt,
        };
      })
    );

    // Stub note: recursive listing, glob filtering, and maxDepth are not yet
    // implemented. The full version would walk the tree up to maxDepth levels,
    // applying the include/exclude globs with fast-glob.
    void recursive;
    void maxDepth;

    return { entries: result, totalCount: result.length };
  },
};

// ---------------------------------------------------------------------------
// Tool: write_file
// ---------------------------------------------------------------------------

const writeFile: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file within the workspace. " +
    "Requires ALLOW_WRITES=true and confirm=true. " +
    "Writing to .git/ or matching blocked patterns is always rejected.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Destination file path.",
      },
      content: {
        type: "string",
        description: "Content to write.",
      },
      encoding: {
        type: "string",
        description: "File encoding. Default: utf-8.",
        default: "utf-8",
      },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they do not exist. Default: false.",
        default: false,
      },
      confirm: {
        type: "boolean",
        description:
          "Must be explicitly true. Required acknowledgement that this is a write operation.",
      },
    },
    required: ["path", "content", "confirm"],
  },

  async handler(args, ctx: ToolContext) {
    if (!ctx.allowWrites) {
      throw new Error("Write operations are disabled. Start the server with ALLOW_WRITES=true.");
    }
    if (args.confirm !== true) {
      throw new Error("confirm must be true. This is required to prevent accidental writes.");
    }

    const filePath = resolveSafe(args.path as string, ctx.workspaceRoot);

    // Block writes inside .git/
    if (filePath.includes(`${path.sep}.git${path.sep}`) || filePath.endsWith(`${path.sep}.git`)) {
      throw new Error("Writing to .git/ is not allowed.");
    }

    const existed = await fs.access(filePath).then(() => true).catch(() => false);

    if (args.createDirs) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }

    const encoding = (args.encoding as BufferEncoding | undefined) ?? "utf-8";
    await fs.writeFile(filePath, args.content as string, encoding);

    const stat = await fs.stat(filePath);
    return { path: filePath, sizeBytes: stat.size, created: !existed };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_exists
// ---------------------------------------------------------------------------

const fileExists: ToolDefinition = {
  name: "file_exists",
  description: "Check whether a file or directory exists within the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to check." },
    },
    required: ["path"],
  },

  async handler(args, ctx: ToolContext) {
    const filePath = resolveSafe(args.path as string, ctx.workspaceRoot);

    try {
      const stat = await fs.lstat(filePath);
      const type = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file";
      return { exists: true, type, path: filePath };
    } catch {
      return { exists: false, type: null, path: filePath };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: get_file_info
// ---------------------------------------------------------------------------

const getFileInfo: ToolDefinition = {
  name: "get_file_info",
  description: "Get metadata for a file without reading its content.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to inspect." },
    },
    required: ["path"],
  },

  async handler(args, ctx: ToolContext) {
    const filePath = resolveSafe(args.path as string, ctx.workspaceRoot);
    const stat = await fs.stat(filePath);

    return {
      path: filePath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
      permissions: (stat.mode & 0o777).toString(8),
      isSymlink: stat.isSymbolicLink(),
      mimeType: null, // TODO: detect via file-type or mime package
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const filesystemTools: ToolDefinition[] = [
  readFile,
  listDir,
  writeFile,
  fileExists,
  getFileInfo,
];
