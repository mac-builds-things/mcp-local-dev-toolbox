# AGENTS.md

This file is especially important: this repository **is itself an MCP server consumed by AI agents**. Read this before making any changes.

## What this server provides

`mcp-local-dev-toolbox` gives AI agents safe, structured access to local development tools — filesystem reads/writes, git introspection, test execution, and codebase search. All operations are sandboxed to a declared set of allowed directories so agents cannot accidentally (or maliciously) touch files outside the project.

## Safety contract

- **All tools operate within `ALLOWED_DIRS`.** Every tool handler passes its path arguments through `PathGuard` before touching the filesystem. If a path resolves outside the allowlist the call is rejected before any I/O occurs.
- **Destructive tools require explicit parameters.** Tools that write, overwrite, or delete content require a `confirm: true` parameter. Agents must pass this explicitly; it cannot be defaulted to `true` by the caller.
- **Audit logging is always on.** Every tool invocation (allowed or blocked) is appended to the audit log by `src/safety.ts`. Do not disable or bypass this.

## Tool inventory

| Tool | Category | Description |
|---|---|---|
| `read_file` | Filesystem | Read a file's contents within an allowed directory |
| `list_dir` | Filesystem | List entries in a directory within an allowed directory |
| `write_file` | Filesystem | Write or overwrite a file; requires `confirm: true` |
| `git_status` | Git | Show working-tree status for a repo within allowed dirs |
| `git_diff` | Git | Show unstaged or staged diff for a repo |
| `git_log` | Git | Show recent commit history |
| `run_tests` | Tests | Run the project's test suite and stream results |
| `grep_codebase` | Search | Search for a pattern across source files |

For full parameter schemas and safety notes, see [`TOOLS.md`](./TOOLS.md).

## Connecting this server

Point your agent runtime at the compiled server:

- **Claude Desktop / claude-config.json** — see [`examples/claude-config.json`](./examples/claude-config.json)
- **Cursor** — see [`examples/cursor-config.json`](./examples/cursor-config.json)

Both config examples show how to set the `ALLOWED_DIRS` environment variable (comma-separated absolute paths).

## What happens when a tool call is blocked

The tool returns a structured error object and does **not** throw:

```json
{
  "error": "Path not in allowed directories",
  "code": "PATH_BLOCKED"
}
```

The rejection is also appended to the audit log with a timestamp, the tool name, and the attempted path. Agents should treat `PATH_BLOCKED` as a hard stop and not retry with a manipulated path.

## What agents must NOT do

- **Do not assume a tool exists** without first checking `TOOLS.md`. The tool list changes as the project evolves.
- **Do not pass unvalidated paths.** Always resolve paths to absolute form and strip `..` segments before passing them to a tool. `PathGuard` will catch violations, but well-behaved agents should not rely on it as the first line of defence.
- **Do not call `write_file` or any destructive tool without user intent.** These tools require `confirm: true`; do not synthesise that flag unless the user has explicitly requested the write or delete.
- **Do not attempt to restart or reconfigure the server from within a tool call.** Server lifecycle is managed by the host environment, not by tools.
