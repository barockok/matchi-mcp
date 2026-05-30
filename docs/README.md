# Matchi Documentation

Matchi is a dataset reconciliation toolkit that mounts into any MCP-capable agentic harness. The docs below cover everything from a first install to the architecture deep-dive. Read them in order if you're new; skim the table of contents if you're looking for a specific topic.

## Table of contents

| # | File | What it covers |
|---|------|----------------|
| 00 | [Overview](./00-overview.md)                              | What Matchi is, who it's for, when to reach for it vs a raw SQL agent. |
| 01 | [Install](./01-install.md)                                | Plugin, npm-global, and source install paths; OS notes; how to verify. |
| 02 | [Quickstart](./02-quickstart.md)                          | Five-minute end-to-end reconciliation: bank vs GL with sample transcript. |
| 03 | [MCP tools](./03-mcp-tools.md)                            | Reference for the seven tools: args, returns, error codes, examples. |
| 04 | [Skill workflow](./04-skill-workflow.md)                  | The six-step recon recipe (recall → inventory → discovery → match → exceptions → report) with rationale. |
| 05 | [Daemon ops](./05-daemon-ops.md)                          | Lifecycle, state files, env vars, `matchi` CLI, upgrades, crash recovery. |
| 06 | [Workspaces](./06-workspaces.md)                          | cwd-to-hash mapping, on-disk layout, backup, GC, concurrency. |
| 07 | [Harness integration](./07-harness-integration.md)        | Config snippets for Claude Code, Cline, Cursor, Continue, and custom MCP clients. |
| 08 | [Troubleshooting](./08-troubleshooting.md)                | Stale pid files, port issues, ingestion failures, error codes, log file. |
| 09 | [Architecture](./09-architecture.md)                      | The full design doc: components, daemon HTTP API, lifecycle, error handling, testing. |
| 10 | [Migration from Electron](./10-migration-from-electron.md)| For existing Matchi desktop users: what changed, what survived, conceptual map. |

## At a glance

- One paragraph: matchi exposes eight MCP tools (`upload_dataset`, `list_sources`, `run_sql`, `run_match`, `recall_known_mistakes`, `save_recipe`, `list_recipes`, `apply_recipe`) backed by a local DuckDB daemon that auto-spawns under `~/.matchi/` and persists per-cwd workspace state across sessions.
- Need to install? Start at [01-install.md](./01-install.md).
- Want to try it? Start at [02-quickstart.md](./02-quickstart.md).
- Want to contribute? Start at [09-architecture.md](./09-architecture.md), then the source tree.
