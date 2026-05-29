# Matchi Overview

Matchi is a dataset reconciliation toolkit that mounts into any agentic harness as a Model Context Protocol (MCP) server. It lets an LLM agent load two or more tabular sources (CSV or XLSX), explore them with DuckDB SQL, propose a match, run the reconciliation, and triage the unmatched rows — all on the user's machine, with no GUI to operate.

## Who it's for

Matchi is for finance, ops, and data engineering teams whose work involves the recurring question "why don't these two ledgers tie?" Concretely:

- Bank statement vs general ledger
- Marketplace settlement reports vs internal sales records
- Accounts receivable vs paid invoices
- Accounts payable vs vendor statements
- Intercompany positions across entities
- P2P lending disbursements vs repayments
- Any other "two or more spreadsheets that should agree but don't" workflow

You bring the harness (Claude Code, Cline, Cursor, Continue, or any MCP-capable client) and the data; Matchi brings the tools and the workflow skill.

## When to reach for Matchi vs a raw SQL agent

A general-purpose SQL agent can technically do reconciliation. Use Matchi when you want any of:

- **Persistent DuckDB.** The daemon keeps loaded sheets and computed match results across harness restarts, scoped to the project directory. Re-running yesterday's recon does not re-ingest a 100 MB CSV.
- **Recon-specific tools.** `run_match` is purpose-built: it takes a `matched_sql` joining two sources aliased as `a` and `b`, derives the unmatched on both sides, exports them as CSVs into the workspace, and stores the run for later paging via `get_exceptions`.
- **Error memory.** The daemon records the agent's prior soft errors per workspace and exposes the top patterns via `recall_known_mistakes`, so the agent can avoid repeating mistakes across sessions.
- **Structured exception paging.** `get_exceptions(match_run_id, side, page)` returns paginated unmatched rows without re-running the join.
- **A guided workflow.** The bundled `matchi` skill teaches the agent the recon recipe: recall → inventory → discovery → candidate match → run_match → exceptions → report.

A bare SQL agent is fine for one-shot exploration. Matchi is for repeatable reconciliation work where the same datasets get revisited and the same mistakes are worth not repeating.

## High-level architecture

```
┌───────────────────────┐  stdio JSON-RPC  ┌────────────────────┐  HTTP/loopback  ┌──────────────────────┐
│ Harness (Claude Code, │ ←──────────────→ │ matchi (shim)      │ ←─────────────→ │ matchi-daemon        │
│ Cline, Cursor, …)     │                  │ stateless Node bin │                 │ Fastify + DuckDB     │
└───────────────────────┘                  └────────────────────┘                 │ + recon/recipe/      │
        ▲                                            │                            │   error-memory stores│
        │ reads                                      │ auto-spawns                └──────────────────────┘
┌───────────────────────┐                            ▼                                       │
│ matchi skill (.md)    │                  ~/.matchi/daemon.json                              ▼
│ workflow + sql idioms │                  (pid, port, version)                     ~/.matchi/workspaces/
└───────────────────────┘                                                            <cwd-hash>/
                                                                                     ├── data.duckdb
                                                                                     ├── meta.duckdb
                                                                                     ├── .token
                                                                                     └── exports/
```

Three units make up the system:

1. **Harness** — your editor or CLI that hosts an LLM agent and speaks MCP. The harness owns the model, the conversation, and the user-facing UX.
2. **`matchi` shim** — a thin Node binary that speaks MCP over stdio to the harness and HTTP over loopback to the daemon. It auto-spawns the daemon on first call and reads the per-workspace bearer token from disk.
3. **`matchi-daemon`** — a Fastify HTTP server on `127.0.0.1:<random-port>` that owns the DuckDB engines, the workspace registry, the stores (recon, recipe, error-memory), and the tool implementations. Exits cleanly after an idle timeout (default 30 minutes).

The skill is a Markdown file bundled in the plugin that teaches the harness *how* to use the tools. See [04-skill-workflow.md](./04-skill-workflow.md).

## What you do next

- [Install Matchi](./01-install.md) (plugin, npm, or source).
- [Run the quickstart](./02-quickstart.md) — a 5-minute end-to-end reconciliation.
- Skim the [tool reference](./03-mcp-tools.md) if you want to know exactly what each tool returns.
- Read the [architecture deep-dive](./09-architecture.md) if you want to contribute.
