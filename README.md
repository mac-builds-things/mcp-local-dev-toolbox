# mcp-local-dev-toolbox

> A local MCP server that gives AI agents safe, explicit access to filesystem, git, and test-runner tools during development.

---

## Why it exists

Most MCP servers are cloud-focused — they wrap APIs, databases, or SaaS products. But when an AI agent is helping you write code, what it actually needs is access to the *local* development environment: read a file, run the tests, check git status, search the codebase.

The problem is that naive tool access is dangerous. A tool called `run_command` that accepts arbitrary shell strings is a footgun. Most existing local-shell MCP servers either expose too much (arbitrary exec) or too little (read-only, no context).

**mcp-local-dev-toolbox** is built around a different philosophy:

- **Explicit tool inventory** — every capability is a named, typed, documented tool. There is no generic exec.
- **Safe defaults** — filesystem writes require the path to be inside an allowlisted workspace root; destructive operations require confirmation flags.
- **Composable servers** — you can run just the filesystem tools, just the git tools, or all of them together.
- **Audit log** — every tool invocation is written to a local audit log so you can review what the agent did.

---

## What makes it interesting

### Explicit tool design
Rather than one `shell` tool, there are purpose-built tools: `git_status`, `run_tests`, `grep_codebase`. Each tool has a narrow, well-defined interface. The agent can't accidentally `rm -rf` something when asking for git status.

### Safety by construction
The `SafetyChecker` runs before every tool call. It enforces:
- Path operations must resolve inside the configured workspace root
- Write operations are opt-in per-session
- A list of never-allowed patterns (e.g. writing to `.git/`, executing scripts outside the project)

### Audit log
Every call is appended to `~/.mcp-local-dev-toolbox/audit.jsonl` with timestamp, tool name, inputs, and whether it was allowed or blocked. This gives you a complete record of agent activity.

### Composable
Each tool category is a separate module. You can mount only the tools you want — useful if you want filesystem + git but not test-running.

---

## Quickstart

### Prerequisites

- Node.js 20+
- An MCP-compatible client (Claude Desktop, Cursor, or any client that supports the MCP protocol)

### Install & run

```bash
git clone https://github.com/yourname/mcp-local-dev-toolbox
cd mcp-local-dev-toolbox
npm install
npm run build

# Start the server against your project workspace
WORKSPACE_ROOT=/path/to/your/project npm start
```

The server listens on stdio by default (as required by the MCP spec for local servers).

### Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-dev-toolbox": {
      "command": "node",
      "args": ["/path/to/mcp-local-dev-toolbox/dist/server.js"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/project",
        "ALLOW_WRITES": "true"
      }
    }
  }
}
```

See [`examples/claude-config.json`](examples/claude-config.json) for a complete example.

### Connect to Cursor

Add to your Cursor MCP settings. See [`examples/cursor-config.json`](examples/cursor-config.json).

---

## Example workflow

With this server running, you can have a conversation like:

> **You:** The tests in `src/auth` are failing. Can you figure out why?

The agent then:
1. Calls `git_status` to understand what changed recently
2. Calls `run_tests` with `pattern: "src/auth"` to see the failures
3. Calls `read_file` on the relevant test files and source files
4. Calls `grep_codebase` to find related usages
5. Proposes a fix, then calls `run_tests` again to verify

All of this happens without the agent having a generic shell — it only has the tools it needs, and every call is logged.

---

## Tool inventory

See [TOOLS.md](TOOLS.md) for the complete, detailed tool reference.

**Quick summary:**

| Category   | Tools |
|------------|-------|
| Filesystem | `read_file`, `list_dir`, `write_file`, `file_exists`, `get_file_info` |
| Git        | `git_status`, `git_diff`, `git_log`, `git_branch`, `git_show` |
| Tests      | `run_tests`, `get_coverage`, `list_test_files` |
| Search     | `grep_codebase`, `find_files`, `search_symbols` |

---

## What this demonstrates

- **MCP server patterns** — how to structure a TypeScript MCP server using `@modelcontextprotocol/sdk`, register tools, handle errors
- **Safe tool design** — the difference between "wrap shell exec" and "explicit, typed, guarded tools"
- **Audit logging** — how to build observability into agent-facing APIs
- **Composable architecture** — splitting tools into modules that can be selectively included

---

## Status

**This is a portfolio/demonstration project.** The tool definitions and server scaffolding are complete and runnable. Some tool implementations are stubs that print their intended behavior — implementing the full logic for every tool is left as an intentional exercise (the architecture is the point, not the line count).

Tools marked `[stub]` in TOOLS.md have interface definitions and safety wiring but delegate to `TODO` implementations. The real implementations would use `simple-git`, `fast-glob`, and child_process with argument arrays (never template strings).

PRs welcome.
