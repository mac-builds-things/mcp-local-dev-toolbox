# mcp-local-dev-toolbox

A local MCP server that gives AI agents safe, explicit access to filesystem, git, search, and test-runner tools — no generic shell exec.

## Setup

```bash
git clone https://github.com/yourname/mcp-local-dev-toolbox
cd mcp-local-dev-toolbox
npm install && npm run build
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-dev-toolbox": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-local-dev-toolbox/dist/server.js"],
      "env": {
        "WORKSPACE_ROOT": "/absolute/path/to/your/project",
        "ALLOW_WRITES": "false",
        "AUDIT_LOG_PATH": "/tmp/mcp-local-dev-toolbox/audit.jsonl"
      }
    }
  }
}
```

Set `ALLOW_WRITES` to `"true"` when you want the agent to edit files. Omit it for read-only access — git, search, and test-running still work. See [`examples/cursor-config.json`](examples/cursor-config.json) for Cursor setup.

## Tools

Full reference: [TOOLS.md](TOOLS.md)

| Tool | Category | Description |
|------|----------|-------------|
| `read_file` | Filesystem | Read a file's contents |
| `write_file` | Filesystem | Write or overwrite a file (requires `ALLOW_WRITES`) |
| `list_dir` | Filesystem | List directory contents |
| `file_exists` | Filesystem | Check if a path exists |
| `git_status` | Git | Working tree status |
| `git_diff` | Git | Diff against HEAD or a ref |
| `git_log` | Git | Commit history |
| `git_branch` | Git | List or switch branches |
| `run_tests` | Tests | Run test suite, optionally filtered by pattern |
| `get_coverage` | Tests | Coverage summary for the workspace |
| `grep_codebase` | Search | Regex search across project files |
| `find_files` | Search | Glob-based file finder |
| `search_symbols` | Search | Symbol-level search (functions, classes) |

## Safety model

- **Path allowlist** — every filesystem operation is validated against `WORKSPACE_ROOT`; paths outside it are rejected before the tool runs.
- **No generic exec** — there is no `run_command` tool. Every capability is a named, typed tool with a narrow interface.
- **Audit log** — every tool call (allowed or blocked) is appended to `AUDIT_LOG_PATH` as newline-delimited JSON.

## Project layout

```
src/
  server.ts          # MCP server entry point
  tools/
    filesystem.ts    # read_file, write_file, list_dir, …
    git.ts           # git_status, git_diff, git_log, …
    tests.ts         # run_tests, get_coverage, …
    search.ts        # grep_codebase, find_files, …
  safety.ts          # SafetyChecker — path validation, write guard
  audit.ts           # Append-only audit log
examples/
  claude-config.json
  cursor-config.json
TOOLS.md             # Complete tool reference
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORKSPACE_ROOT` | Yes | — | Absolute path the agent is allowed to access |
| `ALLOW_WRITES` | No | `false` | Enable `write_file` and other mutating tools |
| `AUDIT_LOG_PATH` | No | `~/.mcp-local-dev-toolbox/audit.jsonl` | Where to write the audit log |

## Status

Portfolio/demonstration project. Tool interfaces, safety wiring, and server scaffolding are complete and runnable. Tools marked `[stub]` in TOOLS.md have full interfaces but delegate to `TODO` implementations — the real logic would use `simple-git`, `fast-glob`, and `child_process` with argument arrays. PRs welcome.
