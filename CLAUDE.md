# CLAUDE.md

## Project

TypeScript MCP server using `@modelcontextprotocol/sdk`. Tools are organized in `src/tools/` (filesystem, git, tests, search). The safety system in `src/safety.ts` enforces path allowlists and audit logging. The server entrypoint is `src/server.ts`.

## Commands

```
npm run build       # Compile TypeScript
npm start           # Start the MCP server
npm run lint        # ESLint
```

## Adding a tool

1. Define the tool in the appropriate `src/tools/*.ts` file
2. Register it in `src/server.ts`
3. Run it through the `PathGuard` in `src/safety.ts` before any filesystem access
4. Add it to `TOOLS.md` with description, parameters, and safety notes
5. **Safety rule:** every tool must have explicit parameter validation — never trust raw input

## Conventions

- Tool names are `snake_case`: `read_file`, `git_status`, `run_tests`
- All filesystem tools must use `PathGuard` to check against `ALLOWED_DIRS`
- No tool should silently swallow errors — return structured error objects
- Destructive operations (write, delete) require explicit confirmation in the tool contract

## Agent notes

This server is itself used by agents. Be especially careful when modifying `safety.ts` — a bug there means agents can escape the sandbox. When adding new tools, check `TOOLS.md` to see if a similar tool already exists. Never add a tool that can make network requests without an explicit `network: true` flag.
