# Tool Reference — mcp-local-dev-toolbox

This document is the authoritative reference for every tool exposed by this MCP server. Each entry includes the tool name, description, input schema, return shape, safety notes, and example call.

---

## Table of Contents

- [Filesystem Tools](#filesystem-tools)
  - [read_file](#read_file)
  - [list_dir](#list_dir)
  - [write_file](#write_file)
  - [file_exists](#file_exists)
  - [get_file_info](#get_file_info)
- [Git Tools](#git-tools)
  - [git_status](#git_status)
  - [git_diff](#git_diff)
  - [git_log](#git_log)
  - [git_branch](#git_branch)
  - [git_show](#git_show)
- [Test Tools](#test-tools)
  - [run_tests](#run_tests)
  - [get_coverage](#get_coverage)
  - [list_test_files](#list_test_files)
- [Search Tools](#search-tools)
  - [grep_codebase](#grep_codebase)
  - [find_files](#find_files)
  - [search_symbols](#search_symbols)

---

## Filesystem Tools

### `read_file`

Read the contents of a file within the workspace.

**Parameters**

| Name       | Type     | Required | Description |
|------------|----------|----------|-------------|
| `path`     | `string` | yes      | Path to the file. May be absolute or relative to `WORKSPACE_ROOT`. |
| `encoding` | `string` | no       | File encoding. Default: `utf-8`. |
| `maxBytes` | `number` | no       | Truncate output after this many bytes. Default: `500000` (500 KB). Prevents accidentally loading a 200 MB binary. |

**Returns**

```ts
{
  content: string;       // File contents (possibly truncated)
  truncated: boolean;    // true if maxBytes was hit
  sizeBytes: number;     // Full file size on disk
  path: string;          // Resolved absolute path
}
```

**Safety notes**
- Path is resolved to an absolute path and checked against `WORKSPACE_ROOT`. If the resolved path is outside the workspace, the call is blocked and logged as `BLOCKED`.
- Symlinks are followed but the resolved target must also be within the workspace.
- Binary files are detected by MIME type; if `encoding` is `utf-8` and the file appears binary, an error is returned with a suggestion to omit the encoding param or use a hex reader.

**Example**
```json
{
  "tool": "read_file",
  "arguments": { "path": "src/auth/index.ts" }
}
```

---

### `list_dir`

List the contents of a directory.

**Parameters**

| Name        | Type      | Required | Description |
|-------------|-----------|----------|-------------|
| `path`      | `string`  | yes      | Directory path, relative or absolute. |
| `recursive` | `boolean` | no       | If `true`, returns all files recursively. Default: `false`. |
| `maxDepth`  | `number`  | no       | When `recursive` is `true`, stop descending after this many levels. Default: `5`. |
| `include`   | `string`  | no       | Glob pattern to filter results (e.g. `"**/*.ts"`). |
| `exclude`   | `string`  | no       | Glob pattern to exclude (e.g. `"**/node_modules/**"`). `node_modules`, `.git`, and `dist` are always excluded. |

**Returns**

```ts
{
  entries: Array<{
    name: string;
    path: string;          // Absolute path
    type: "file" | "dir" | "symlink";
    sizeBytes: number | null;  // null for dirs
    modifiedAt: string;    // ISO 8601
  }>;
  totalCount: number;
}
```

**Safety notes**
- Root path must resolve inside `WORKSPACE_ROOT`.
- `node_modules`, `.git`, and `dist` are unconditionally excluded from results regardless of `exclude` param.
- `maxDepth` caps at `10` regardless of what is passed.

**Example**
```json
{
  "tool": "list_dir",
  "arguments": { "path": "src", "recursive": true, "include": "**/*.ts" }
}
```

---

### `write_file`

Write or overwrite a file within the workspace.

**Parameters**

| Name        | Type      | Required | Description |
|-------------|-----------|----------|-------------|
| `path`      | `string`  | yes      | Destination path. |
| `content`   | `string`  | yes      | File content to write. |
| `encoding`  | `string`  | no       | Default: `utf-8`. |
| `createDirs`| `boolean` | no       | If `true`, create parent directories if they don't exist. Default: `false`. |
| `confirm`   | `boolean` | yes      | Must be explicitly `true`. A required acknowledgement that this is a write operation. Forces the agent to be deliberate. |

**Returns**

```ts
{
  path: string;          // Resolved absolute path written to
  sizeBytes: number;
  created: boolean;      // true if file did not exist before
}
```

**Safety notes**
- **Writes are disabled by default.** The server must be started with `ALLOW_WRITES=true` or the call is blocked unconditionally.
- Path must resolve inside `WORKSPACE_ROOT`.
- Writing to `.git/` is always blocked.
- Writing to files matching `BLOCKED_WRITE_PATTERNS` (configurable, e.g. `*.env`, `*.pem`, `*secret*`) is blocked.
- `confirm: true` is a required field — this is intentional friction. The agent must explicitly pass it; it cannot be defaulted from a template.
- Writes are appended to the audit log with full content hash.

**Example**
```json
{
  "tool": "write_file",
  "arguments": {
    "path": "src/utils/helpers.ts",
    "content": "export const add = (a: number, b: number) => a + b;\n",
    "confirm": true
  }
}
```

---

### `file_exists`

Check whether a file or directory exists.

**Parameters**

| Name   | Type     | Required | Description |
|--------|----------|----------|-------------|
| `path` | `string` | yes      | Path to check. |

**Returns**

```ts
{
  exists: boolean;
  type: "file" | "dir" | "symlink" | null;  // null if not found
  path: string;
}
```

**Safety notes**
- Path is workspace-checked. Even existence checks for paths outside the workspace are blocked (avoids path probing).

---

### `get_file_info`

Get metadata for a file without reading its content.

**Parameters**

| Name   | Type     | Required | Description |
|--------|----------|----------|-------------|
| `path` | `string` | yes      | Path to inspect. |

**Returns**

```ts
{
  path: string;
  sizeBytes: number;
  modifiedAt: string;   // ISO 8601
  createdAt: string;
  permissions: string;  // e.g. "644"
  isSymlink: boolean;
  mimeType: string | null;
}
```

---

## Git Tools

> All git tools operate on the git repository at or containing `WORKSPACE_ROOT`. They are read-only by design — there are no tools for `commit`, `push`, `reset`, or any operation that modifies git history.

### `git_status`

Show the working tree status: staged changes, unstaged changes, and untracked files.

**Parameters**

| Name         | Type      | Required | Description |
|--------------|-----------|----------|-------------|
| `short`      | `boolean` | no       | Return short-format status. Default: `false`. |
| `showBranch` | `boolean` | no       | Include branch info in output. Default: `true`. |

**Returns**

```ts
{
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  untracked: string[];
  isClean: boolean;
}
```

**Safety notes**
- Read-only. No git state is modified.

**Example**
```json
{ "tool": "git_status", "arguments": {} }
```

---

### `git_diff`

Show changes between commits, the index, or working tree.

**Parameters**

| Name       | Type      | Required | Description |
|------------|-----------|----------|-------------|
| `staged`   | `boolean` | no       | Show staged (index) diff instead of working tree diff. Default: `false`. |
| `from`     | `string`  | no       | Starting ref (commit hash, branch name, tag). |
| `to`       | `string`  | no       | Ending ref. If `from` is set and `to` is omitted, diffs `from` against HEAD. |
| `path`     | `string`  | no       | Limit diff to a specific file or directory. |
| `contextLines` | `number` | no   | Number of context lines. Default: `3`. |
| `maxLines` | `number`  | no       | Truncate diff after this many lines. Default: `2000`. |

**Returns**

```ts
{
  diff: string;         // Unified diff text
  truncated: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
}
```

**Safety notes**
- Read-only.
- `maxLines` caps at `5000` regardless of input.

**Example**
```json
{
  "tool": "git_diff",
  "arguments": { "staged": true, "path": "src/auth" }
}
```

---

### `git_log`

Show commit history.

**Parameters**

| Name      | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `limit`   | `number` | no       | Maximum number of commits to return. Default: `20`. Max: `100`. |
| `branch`  | `string` | no       | Branch or ref to show log for. Default: current branch. |
| `path`    | `string` | no       | Filter commits that touched this path. |
| `author`  | `string` | no       | Filter by author name or email (substring match). |
| `since`   | `string` | no       | Only show commits after this date (ISO 8601 or git date syntax). |
| `until`   | `string` | no       | Only show commits before this date. |
| `format`  | `string` | no       | `"structured"` (default) or `"oneline"`. |

**Returns**

```ts
{
  commits: Array<{
    hash: string;
    shortHash: string;
    author: string;
    email: string;
    date: string;       // ISO 8601
    subject: string;
    body: string;
  }>;
  total: number;
}
```

---

### `git_branch`

List branches.

**Parameters**

| Name      | Type      | Required | Description |
|-----------|-----------|----------|-------------|
| `all`     | `boolean` | no       | Include remote-tracking branches. Default: `false`. |
| `verbose` | `boolean` | no       | Include last commit info per branch. Default: `false`. |

**Returns**

```ts
{
  current: string;
  branches: Array<{
    name: string;
    isRemote: boolean;
    lastCommitHash: string | null;
    lastCommitSubject: string | null;
    lastCommitDate: string | null;
  }>;
}
```

---

### `git_show`

Show the contents of a specific commit or a file at a specific ref.

**Parameters**

| Name    | Type     | Required | Description |
|---------|----------|----------|-------------|
| `ref`   | `string` | yes      | Commit hash, tag, or branch name. |
| `path`  | `string` | no       | If provided, show the file at this path as it existed at `ref`, rather than the full commit diff. |

**Returns**

```ts
// Without path (full commit):
{
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  diff: string;
}

// With path (file at ref):
{
  ref: string;
  path: string;
  content: string;
  sizeBytes: number;
}
```

---

## Test Tools

> Test tools run your project's test suite. The specific runner (Jest, Vitest, Mocha, etc.) is detected from `package.json` and executed via `npm test` with constructed arguments. No arbitrary flags are passed — only a known-safe set.

### `run_tests`

Run the test suite or a subset of it.

**Parameters**

| Name       | Type      | Required | Description |
|------------|-----------|----------|-------------|
| `pattern`  | `string`  | no       | File glob or test name pattern to filter which tests run. Passed to the runner's `--testPathPattern` or equivalent. |
| `watch`    | `boolean` | no       | Run in watch mode. **Not supported** — always `false`. Watch mode requires an interactive terminal and is not appropriate for agent use. |
| `timeout`  | `number`  | no       | Per-test timeout in milliseconds. Default: runner's default. |
| `bail`     | `boolean` | no       | Stop after the first failure. Default: `false`. |
| `maxRunMs` | `number`  | no       | Kill the test process after this many milliseconds. Default: `120000` (2 min). Cap: `300000`. |

**Returns**

```ts
{
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  output: string;       // Full stdout+stderr of the test runner
  exitCode: number;
  timedOut: boolean;
  failures: Array<{
    testName: string;
    filePath: string;
    message: string;
    stack: string | null;
  }>;
}
```

**Safety notes**
- The test runner is invoked as a child process with `shell: false` and a fixed argument array. There is no shell interpolation.
- `watch: true` is rejected — test watchers cannot safely be managed inside a single MCP tool call.
- The process is forcibly killed after `maxRunMs`.
- `WORKSPACE_ROOT` is the working directory for the test run.

**Example**
```json
{
  "tool": "run_tests",
  "arguments": { "pattern": "src/auth", "bail": true }
}
```

---

### `get_coverage`

Run the test suite with coverage and return a summary.

**Parameters**

| Name      | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `pattern` | `string` | no       | Limit to specific files/tests. |
| `maxRunMs`| `number` | no       | Default: `180000` (3 min). |

**Returns**

```ts
{
  summary: {
    lines:      { total: number; covered: number; pct: number };
    statements: { total: number; covered: number; pct: number };
    functions:  { total: number; covered: number; pct: number };
    branches:   { total: number; covered: number; pct: number };
  };
  files: Array<{
    path: string;
    lines:      { total: number; covered: number; pct: number };
    functions:  { total: number; covered: number; pct: number };
    branches:   { total: number; covered: number; pct: number };
  }>;
  durationMs: number;
  output: string;
}
```

---

### `list_test_files`

List all test files in the workspace without running them.

**Parameters**

| Name      | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `pattern` | `string` | no       | Glob to filter results. |

**Returns**

```ts
{
  files: string[];   // Absolute paths
  total: number;
}
```

---

## Search Tools

### `grep_codebase`

Search for a pattern across files in the workspace. Uses ripgrep internally for performance.

**Parameters**

| Name          | Type       | Required | Description |
|---------------|------------|----------|-------------|
| `pattern`     | `string`   | yes      | Search pattern. Treated as a literal string unless `regex: true`. |
| `regex`       | `boolean`  | no       | Interpret `pattern` as a regular expression. Default: `false`. |
| `caseSensitive`| `boolean` | no       | Default: `false`. |
| `include`     | `string`   | no       | Glob to limit which files are searched (e.g. `"**/*.ts"`). |
| `exclude`     | `string`   | no       | Glob to exclude. `node_modules` and `.git` are always excluded. |
| `maxResults`  | `number`   | no       | Maximum number of matching lines to return. Default: `200`. Cap: `1000`. |
| `contextLines`| `number`   | no       | Lines of context before/after each match. Default: `2`. Max: `10`. |

**Returns**

```ts
{
  matches: Array<{
    path: string;
    line: number;
    column: number;
    text: string;        // The matching line
    context: {
      before: string[];
      after: string[];
    };
  }>;
  total: number;
  truncated: boolean;    // true if maxResults was hit
  filesSearched: number;
  filesMatched: number;
  durationMs: number;
}
```

**Safety notes**
- Runs ripgrep (`rg`) with `--no-heading --json`. If `rg` is not installed, falls back to a slower Node.js implementation.
- Pattern is passed as an argument, never interpolated into a shell string.
- `maxResults` prevents runaway output on broad patterns.

**Example**
```json
{
  "tool": "grep_codebase",
  "arguments": {
    "pattern": "useAuth",
    "include": "**/*.tsx",
    "contextLines": 3
  }
}
```

---

### `find_files`

Find files by name pattern within the workspace.

**Parameters**

| Name        | Type      | Required | Description |
|-------------|-----------|----------|-------------|
| `pattern`   | `string`  | yes      | Glob or filename pattern to match (e.g. `"*.config.ts"`, `"auth*"`). |
| `directory` | `string`  | no       | Subdirectory to search within. Default: workspace root. |
| `maxResults`| `number`  | no       | Default: `500`. Cap: `2000`. |

**Returns**

```ts
{
  files: Array<{
    path: string;
    name: string;
    directory: string;
    sizeBytes: number;
    modifiedAt: string;
  }>;
  total: number;
  truncated: boolean;
}
```

---

### `search_symbols`

Search for TypeScript/JavaScript symbols (functions, classes, types, variables) by name.

**Parameters**

| Name          | Type      | Required | Description |
|---------------|-----------|----------|-------------|
| `name`        | `string`  | yes      | Symbol name to search for. Substring match. |
| `kind`        | `string`  | no       | Filter by kind: `"function"`, `"class"`, `"interface"`, `"type"`, `"variable"`, `"const"`, `"enum"`. Omit to search all. |
| `include`     | `string`  | no       | File glob to limit search. |
| `maxResults`  | `number`  | no       | Default: `100`. |

**Returns**

```ts
{
  symbols: Array<{
    name: string;
    kind: string;
    path: string;
    line: number;
    column: number;
    snippet: string;    // The line defining the symbol
  }>;
  total: number;
  truncated: boolean;
}
```

**Notes**
- This tool uses a fast regex heuristic (not a full AST parser) to find symbol definitions. It is fast and good enough for navigation, but may miss symbols in complex destructuring patterns.
- For full semantic analysis, consider pointing the agent at the TypeScript language server directly.

---

## Safety Model Summary

All tools share a common safety pipeline:

```
Tool call received
  → Input schema validation (Zod)
  → SafetyChecker.preCheck(tool, args)
      → Workspace path enforcement
      → Operation allowlist check
      → Session permission check (e.g. ALLOW_WRITES)
  → Tool handler executes
  → AuditLogger.record(tool, args, result, allowed)
  → Response returned to client
```

Blocked calls return an MCP error response with a human-readable reason. They are never silently dropped — the agent always knows a call was blocked, and why.
