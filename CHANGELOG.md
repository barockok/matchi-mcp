# Changelog

## v0.0.1 — 2026-05-29

Initial release. Pivots Matchi from a standalone Electron desktop application into a Claude Code plugin (MCP server + skill) backed by a local HTTP daemon.

### Highlights
- `matchi-mcp` stdio MCP server, mountable in any MCP-compatible agentic harness (Claude Code, Cline, Cursor, Continue, custom)
- `matchi-daemon` Fastify HTTP service on loopback, auto-spawned by the shim. Owns DuckDB engine, recon store, recipe store, and error-memory store.
- Per-cwd workspace isolation under `~/.matchi/workspaces/<sha1(cwd)[:12]>/`. Idle daemon exits after 30 minutes (configurable).
- 7 MCP tools: `upload_dataset`, `list_sources`, `load_sheet`, `run_sql`, `run_match`, `get_exceptions`, `recall_known_mistakes`.
- `matchi` skill with the reconciliation workflow recipe and DuckDB SQL patterns.
- `matchi` CLI: `doctor`, `start`, `stop`, `logs`, `gc`.
- Documentation suite under `docs/` and published to GitHub Pages.
- Architecture spec at `docs/09-architecture.md`.

## v0.0.2 — 2026-05-29

Claude Code plugin marketplace compliance.

- Move manifest to `.claude-plugin/plugin.json` (canonical location).
- Rename `mcp_servers` array → `mcpServers` object (camelCase, official schema).
- Add `.claude-plugin/marketplace.json` so the repo can be added as a marketplace via `/plugin marketplace add barockok/matchi-mcp`.
- README: replace pseudo-CLI install with the real `/plugin marketplace add` + `/plugin install` flow. List all 7 MCP tools (was 5).

## v0.0.3 — 2026-05-29

Actually apply the v0.0.2 marketplace fixes (the prior commit's manifest content was not updated due to a tooling failure).

- `.claude-plugin/plugin.json` now uses `mcpServers` (camelCase object), version 0.0.3.
- `package.json` `files` array references `.claude-plugin/` (was stale `plugin.json` path).

## v0.0.4 — 2026-05-29

Drop npm registry as distribution channel — GitHub release tarball + git-installable only.

- `.github/workflows/release.yml`: remove `npm publish` step. Build tarball with `npm pack` and attach it to the GitHub release instead.
- README: install via `npm install -g https://.../releases/latest/download/matchi-mcp.tgz` or `npm install -g github:barockok/matchi-mcp`.
- `package.json`: add `prepare: tsup` so git installs build `dist/` automatically; drop `publishConfig` (npm-registry-specific).

## v0.1.0 — 2026-05-29

Rename `matchi-mcp` → `matchi` across the entire surface.

- Package name `matchi-mcp` → `matchi`. Repo renamed `barockok/matchi-mcp` → `barockok/matchi`.
- Bin: the stdio MCP shim (`matchi-mcp`) and CLI (`matchi`) are now a single bin called `matchi`. No subcommand → MCP stdio server; subcommand (`doctor|start|stop|logs|gc`) → CLI. `matchi-daemon` unchanged.
- Plugin manifest `command` field is now `matchi`. Marketplace listing repo URL is `barockok/matchi`.
- Install URLs updated to the new package + repo names.

**Breaking:** harness MCP configs that reference `"command": "matchi-mcp"` must update to `"command": "matchi"`. Reinstall: `npm install -g matchi` (or `npm install -g github:barockok/matchi`).

## v0.1.1 — 2026-05-30

Fix plugin install (issue #1).

- `.claude-plugin/plugin.json` now uses `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/bin/matchi.js"]` so the MCP server resolves from the plugin install dir instead of relying on `matchi` being on `PATH`.
- Commit built `dist/` artifacts. Claude Code's plugin installer copies repo contents as-is without running `npm install`, so the dynamic imports in `bin/matchi.js` (`../dist/mcp/server.js`, `../dist/cli/index.js`) need `dist/` to exist in-repo.
- `.gitignore`: stop ignoring `dist`.
