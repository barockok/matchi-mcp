# Migration from the Electron Matchi

This page is for existing users of the standalone Matchi desktop app (the `kalla-v2` Electron repo). matchi-mcp is the same reconciliation engine repackaged as an MCP server. The mission is identical; the surface is different.

## What changed

### No GUI

There is no window, no chat panel, no settings page. The conversation happens in your harness (Claude Code, Cline, Cursor, Continue). Matchi just provides tools and a workflow skill. If you liked the chat UX, you'll get it from the harness; if you liked the file-upload button, it's now `upload_dataset({"path": "..."})`.

### No provider / API key management

The Electron app had a provider page (Gemini, Claude, OpenAI, custom endpoints) with API keys, base URLs, and model selection. matchi-mcp doesn't manage any of this — the harness owns the model. Your harness already has its own provider configuration.

If you were a heavy user of the OpenCode Free default provider, you still use it — but through Claude Code's provider config, not through Matchi.

### Workspace state is per-cwd, not global

The Electron app had a single global state: all uploaded sources, all recon runs, all settings lived in one place. matchi-mcp scopes everything to the harness's current working directory via `sha1(cwd)[:12]`. Open `~/project-a` and `~/project-b` — they get separate workspaces, separate DuckDB files, separate error memory.

This is a feature: project A's noise doesn't pollute project B's match history. See [06-workspaces.md](./06-workspaces.md).

### No Google Sheets, no OpenCode Free OAuth

The Google Sheets integration and the OAuth flow for OpenCode Free are gone. matchi-mcp loads local CSV and XLSX files. If your data lives in Google Sheets, export to XLSX or CSV first.

### No automatic updates UI

The Electron auto-updater is gone (it was a release-pipeline feature, not a recon feature). Upgrade via `npm install -g matchi-mcp@latest` or `claude plugin update matchi`.

## What survived

### The recon engine

Same DuckDB engine. Same `run_match` semantics — pass a `matched_sql` aliased as `a` and `b`, the tool derives unmatched via implicit `NOT EXISTS` on shared columns, exports CSVs, persists the run, and lets you page through exceptions later. The CSV export is in the same shape.

### The five tools (now seven)

| Electron tool       | matchi-mcp tool        | Notes                                                                  |
|---------------------|------------------------|------------------------------------------------------------------------|
| `list_sources`      | `list_sources`         | Unchanged.                                                             |
| `load_sheet`        | `load_sheet`           | Unchanged. XLSX-specific.                                              |
| `run_sql`           | `run_sql`              | Unchanged. Same 20-row cap, same batch mode, same dangerous-keyword list. |
| `run_match`         | `run_match`            | Unchanged in args and return shape.                                    |
| `get_exceptions`    | `get_exceptions`       | Unchanged.                                                             |
| —                   | `upload_dataset`       | **New.** Replaces the file-upload UI button. Accepts a local CSV/XLSX path. |
| —                   | `recall_known_mistakes`| **New.** Exposes the error-memory store as a callable tool. The skill calls it at session start. |

### Error memory

Same store, same dedup key (`tool_name, error_category`), same 30-day expiry. The difference: in the Electron app the top patterns were silently injected into the system prompt. In matchi-mcp, the agent explicitly calls `recall_known_mistakes` at session start (per the skill). This makes the mechanism visible — you can see the agent reading its prior mistakes.

### Recipe store

The recipe-store concept survives but is not currently exposed as an MCP tool. The data structures and persistence exist (`src/daemon/stores/recipe-store.ts`); a future tool may surface them for "save this match as a recipe to re-run next month".

> TODO: recipe-store has no MCP tool exposure yet. Track upstream.

## Data migration

**There is no automatic migration.** Electron-era data lived under the Electron `userData` directory (`~/Library/Application Support/Matchi/` on macOS, equivalent paths on Linux/Windows); matchi-mcp data lives under `~/.matchi/workspaces/<hash>/`. The DuckDB file formats are compatible (both `@duckdb/node-api` v1.4.4), but the directory structure, the meta-schema, and the workspace-scoping model are different.

The practical migration:

1. Identify your important source files. They're on your disk wherever you originally uploaded them from.
2. `cd` into the project where those files live.
3. Re-upload via `upload_dataset` from your harness.
4. Re-run any reconciliations you care about.

Error memory does not migrate. You'll start with an empty pattern table and accumulate again from the first session.

## Conceptual map: where did everything go

| Electron feature                           | matchi-mcp equivalent                                                                          |
|--------------------------------------------|------------------------------------------------------------------------------------------------|
| File-upload UI button                      | `upload_dataset` tool                                                                          |
| Source browser / sidebar                   | `list_sources` tool                                                                            |
| Chat panel                                 | Your harness's chat panel                                                                      |
| Settings → Providers                       | Your harness's provider config                                                                 |
| Settings → Agent Error Memory              | `recall_known_mistakes` tool + `meta.duckdb` per workspace                                     |
| Reconciliation results view                | `get_exceptions` (rows) + `unmatchedAFile`/`unmatchedBFile` CSV paths from `run_match`         |
| Recipes UI                                 | Recipe store exists in `meta.duckdb`; no MCP tool yet (TODO)                                   |
| Google Sheets integration                  | Removed. Export to XLSX/CSV.                                                                   |
| OpenCode Free auth                         | Removed. Your harness owns the model.                                                          |
| Auto-update                                | npm install / claude plugin update                                                             |
| `~/Library/Application Support/Matchi/`    | `~/.matchi/` (configurable via `MATCHI_HOME`)                                                  |
| Provider env vars (`ANTHROPIC_API_KEY`, …) | Removed. Harness handles the model.                                                            |

## When to keep using the Electron app

For now, if you genuinely prefer a GUI and don't want to run an agentic harness, the Electron app still works. It's not actively developed but the existing release is stable.

If you want the agent to *learn* across sessions and *follow a discipline* (recall → discovery → match → exceptions), matchi-mcp is what you want — the skill is the codified discipline, and the harness running the skill is the agent.
