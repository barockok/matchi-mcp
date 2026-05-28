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
