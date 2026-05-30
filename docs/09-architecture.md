# Matchi MCP Pivot — Design

**Date:** 2026-05-28
**Status:** Shipped
**Author:** brainstorming session

## 1. Goal

Convert Matchi from a standalone Electron desktop application into a Claude Code plugin (MCP server + skill) backed by a long-running local daemon. The reconciliation mission is unchanged: agents explore tabular datasets, discover matching patterns, run reconciliation, and surface exceptions. The surface changes — instead of a GUI, Matchi mounts into any MCP-compatible agentic harness (Claude Code, Cline, Cursor, Continue, custom).

The Electron app (`kalla-v2`) remains untouched in its current repo. This design lives in a **new repo** (`matchi`).

## 2. Non-goals

- Remote daemon. Loopback only.
- Multi-tenant auth. Single OS user owns `~/.matchi/`.
- A web UI. The harness conversation is the UI.
- Bundling an LLM provider. The harness supplies the model; the daemon only runs tools.
- Migration of the Electron app users' on-disk state. New install, new state.

## 3. Architecture

```
┌───────────────────────┐  stdio JSON-RPC  ┌────────────────────┐  HTTP/loopback  ┌──────────────────────┐
│ Harness (Claude Code, │ ←──────────────→ │ matchi (shim)      │ ←─────────────→ │ matchi-daemon        │
│ Cline, Cursor, …)     │                  │ stateless Node bin │                 │ Fastify + DuckDB     │
└───────────────────────┘                  └────────────────────┘                 │ + recon/recipe/      │
        ▲                                            │                            │   error-memory stores│
        │ reads                                      │ auto-spawns                └──────────────────────┘
┌───────────────────────┐                            ▼                                       │
│ matchi skill (.md)    │                  ~/.matchi/daemon.json                              ▼
│ workflow recipe       │                  (pid, port, token)                       ~/.matchi/workspaces/
└───────────────────────┘                                                           <cwd-hash>/
                                                                                    ├── data.duckdb
                                                                                    ├── meta.duckdb
                                                                                    └── .token
```

### Three units

- **`matchi` (shim).** Node bin that speaks MCP stdio. Each tool call is a stateless HTTP request to the daemon. Auto-spawns the daemon if `~/.matchi/daemon.json` is missing or its PID is dead. Reads workspace bearer token from `~/.matchi/workspaces/<hash>/.token` after the daemon writes it on first contact for a new cwd.
- **`matchi-daemon`.** Long-running Node process. Fastify HTTP listener on `127.0.0.1:<random-port>`. Owns the DuckDB engine, recon store, recipe store, and error-memory store. Per-workspace isolation: workspace directory is derived from the harness's `cwd` (sha1, first 12 chars) and rooted under `~/.matchi/workspaces/`. Idle-timeout (default 30 min, configurable) releases RAM by exiting cleanly; next MCP call respawns it.
- **`matchi` skill.** Markdown skill bundled in the plugin. Replaces the Electron app's system prompt. Teaches the harness the reconciliation workflow (discovery → SQL probe → match candidate → run_match → exceptions → recipe) and DuckDB recon SQL idioms. Activated when the agent is asked to reconcile, match, or analyze tabular data.

### Why a separate daemon

- **Persistence across harness restarts.** DuckDB state, loaded sheets, recon results, and accumulated error-memory survive the harness session. Re-running yesterday's recon does not re-ingest a 100 MB CSV.
- **Process isolation.** DuckDB native bindings and large memory footprints live outside the harness process.
- **Multiple-harness friendliness.** Several harness instances in different repos can hit the same daemon, each scoped to its own workspace.

### Why a shim instead of HTTP-MCP transport

Stdio MCP works in every current harness. Streamable-HTTP MCP support is uneven. The shim is ~150 lines and gives universal compatibility.

## 4. Plugin package layout

```
matchi/
├── package.json            # bins: matchi, matchi-daemon
├── plugin.json             # Claude Code plugin manifest (mcp + skill refs)
├── bin/
│   ├── matchi.js           # unified bin: MCP stdio (no args) / CLI (doctor, start, stop, logs, gc)
│   └── matchi-daemon.js    # daemon entry
├── src/
│   ├── mcp/
│   │   ├── server.ts       # MCP tool registrations
│   │   └── http-client.ts  # daemon RPC + SSE consumer
│   ├── daemon/
│   │   ├── server.ts       # Fastify app + routes
│   │   ├── workspace.ts    # cwd→dir, lockfile, idle timer, token
│   │   ├── auth.ts         # bearer check
│   │   ├── lifecycle.ts    # PID file, port pick, graceful shutdown
│   │   ├── tools/          # ported from kalla-v2 src/main/agent/tools/
│   │   ├── stores/         # ported recon-store, recipe-store, error-memory-store
│   │   ├── db/
│   │   │   ├── engine.ts   # DuckDB connection mgmt
│   │   │   └── ingestion.ts# CSV/XLSX loader (no Electron deps)
│   │   └── progress.ts     # SSE event bus for run_match phases
│   ├── cli/                # matchi CLI subcommands
│   └── shared/
│       ├── types.ts
│       └── protocol.ts     # request/response shapes
├── skills/
│   └── matchi/
│       ├── SKILL.md        # frontmatter + workflow body
│       ├── workflow.md     # extended patterns
│       └── sql-patterns.md # DuckDB recon idioms
├── docs/                   # see §9
└── tests/
    ├── unit/
    ├── integration/        # spawns real daemon in tmpdir
    └── fixtures/           # ported scripts/fixtures/seed-data.ts
```

## 5. MCP tool surface

Eight tools.

| Tool                    | Args                                                                    | Returns                                                                                    | Notes |
|-------------------------|-------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|-------|
| `upload_dataset`        | `path`, `alias?`, `sheet?`, `materialize?`, `description?`              | `{table_name, rows, columns[], mode}`                                                      | Zero-copy `CREATE VIEW` by default; `materialize:true` for a snapshot table. `sheet` for XLSX. |
| `list_sources`          | —                                                                       | `[{table, rows, columns[], is_view}]`                                                      | Derived from `information_schema.tables`. |
| `run_sql`               | `sql` *or* `queries[]`, `description?`                                  | rows (20-row cap, danger keywords blocked)                                                 | Batch mode (up to 10 queries) preserved. Per-query error isolation. |
| `run_match`             | `matched_sql`, `a`, `b`, `description?`                                 | `{matched, unmatched_a_total, unmatched_b_total, unmatched_a_preview, unmatched_b_preview, match_run_id}` | Inline previews ≤200 rows/side. matched_sql must alias datasets `a`/`b`. |
| `recall_known_mistakes` | —                                                                       | `{patterns: [...]}`                                                                        | Top-10 prior errors in this workspace. |
| `save_recipe`           | `name`, `match_sql`, `sources[2]`, `description?`, `overwrite?`         | `{name}`                                                                                   | Persists recipe; `recipe_exists` if name taken and not overwriting. |
| `list_recipes`          | —                                                                       | `{recipes: [...]}`                                                                         | Lists saved recipes with last-run stats. |
| `apply_recipe`          | `name`                                                                  | same shape as `run_match`                                                                  | `sources_missing` if any source alias absent. |

**Dropped from the Electron build:**
- Provider management, settings, API keys (harness owns the model).
- Google Sheets / OpenCode Free / OAuth flows.
- Session UI tools.

Every tool receives an implicit `workspace_hash` from the shim. The shim computes `sha1(cwd).slice(0, 12)` itself (deterministic; both sides agree) and uses it as the path segment when calling the daemon. The agent never sees or supplies it.

The skill instructs the agent to call `recall_known_mistakes` once at session start (before the first `run_sql`), and to check `list_recipes` for a saved recipe that fits before deriving anything new.

## 6. Daemon HTTP API

Loopback-only. Per-workspace bearer token, generated on first workspace touch, stored at `~/.matchi/workspaces/<hash>/.token` with mode `0600`. The shim reads it before each call.

```
GET  /healthz                                              → {ok, version, uptime_s}
POST /v1/workspaces/:hash/tools/:name                      → tool result JSON
GET  /v1/workspaces/:hash/tools/run_match/stream?id=<uuid> → SSE: tool_progress events
GET  /v1/workspaces/:hash/state                            → {sources, last_recon, recipes}
POST /v1/shutdown                                          → graceful exit
```

- All non-public routes require `Authorization: Bearer <workspace-token>`.
- `run_match` returns a job id immediately if `stream=true`; client opens SSE to consume `tool_progress` events; final result delivered as the SSE terminator event.
- 400/404/409/500 use a uniform `{error: {code, message, hint?}}` shape.

## 7. Lifecycle

1. Harness invokes any MCP tool.
2. Shim reads `~/.matchi/daemon.json`. If missing, or `kill -0 pid` fails, or `/healthz` doesn't respond within 1500 ms → spawn `matchi-daemon` detached, capture `pid`, port (daemon picks a random free port and writes it), and rewrite `daemon.json`.
3. Shim issues HTTP call to `/v1/workspaces/<hash>/...` (hash computed shim-side). Daemon lazy-creates the workspace dir on first reference, lazy-opens DuckDB files, returns response.
4. Idle timer in daemon: if no request for N minutes (default 30), graceful shutdown — close DuckDB, fsync, delete `daemon.json`.
5. `matchi doctor` prints PID, port, uptime, workspace list, logs path. `matchi stop` POSTs `/v1/shutdown`. `matchi gc --older-than 30d` removes stale workspaces.

## 8. Error handling

- **Daemon unavailable after autospawn:** tool returns `{error: {code: "daemon_unavailable", hint: "run `matchi doctor`"}}`.
- **Workspace token mismatch:** 401 → shim regenerates from disk on retry; if still mismatched, surface error.
- **DuckDB lock contention:** retry once with 100 ms backoff, then surface.
- **Tool soft errors** (existing pattern — tool returns `{error: "..."}` rather than throwing): error-memory-store records the (tool, category) pair, scoped to the workspace. Agent reads accumulated patterns via the `recall_known_mistakes` MCP tool (see §5).
- **CSV/XLSX ingestion failures:** wrap DuckDB read_csv_auto errors with the offending column/row hint.

## 9. Documentation ("top-class")

Shipped under `docs/`, published to GitHub Pages, and indexed in README.

| File | Audience | Contents |
|---|---|---|
| `00-overview.md`            | new visitor       | What Matchi is, who it's for, when to reach for it vs raw SQL agents. |
| `01-install.md`             | end user          | `claude plugin install`, npm global install, manual MCP config, OS notes. |
| `02-quickstart.md`          | end user          | 5-min walkthrough: upload two CSVs, run a recon, read exceptions. |
| `03-mcp-tools.md`           | agent + user      | Per-tool spec: name, args, returns, examples, error cases. |
| `04-skill-workflow.md`      | agent + user      | The reconciliation recipe (discovery → SQL → match → exceptions → recipe). |
| `05-daemon-ops.md`          | power user / ops  | PID/port/token files, logs, idle timeout, manual start/stop, env vars. |
| `06-workspaces.md`          | power user        | cwd hashing, disk layout, GC, backup, what to commit vs gitignore. |
| `07-harness-integration.md` | integrators       | Claude Code, Cline, Cursor, Continue, custom MCP harnesses — config snippets. |
| `08-troubleshooting.md`     | end user          | Port conflicts, stale lock, duckdb corruption, permissions on macOS/Linux. |
| `09-architecture.md`        | contributor       | A durable copy of this design doc. |
| `10-migration-from-electron.md` | existing Matchi user | What changed, equivalents, how to move data. |

## 10. Testing

- **Unit:** ported tool modules keep their existing public surface; tests come along. Workspace, lifecycle, auth modules new.
- **Integration:** spin up a real daemon under a temp `HOME` env, hit HTTP, assert recon end-to-end against `scripts/fixtures/seed-data.ts` (ported from kalla-v2).
- **MCP-shim:** golden tests with the official `@modelcontextprotocol/sdk` test harness, verifying tool schemas and round-trips.
- **No Electron, no UI tests.**

## 11. Implementation phasing (proposed; finalized by writing-plans)

Phased so each step is independently demoable.

1. **Daemon skeleton:** Fastify server, `/healthz`, workspace dir + token, lifecycle/PID, idle timer, `matchi` CLI subset (`start`, `stop`, `doctor`).
2. **Port DuckDB engine + ingestion** from `src/main/db/`. Adapt to non-Electron paths. Add `upload_dataset`.
3. **Port tools** (`list_sources`, `load_sheet`, `run_sql`, `run_match`, `get_exceptions`) and the recon/recipe/error-memory stores. Wire to HTTP routes.
4. **SSE progress** for `run_match`.
5. **MCP shim:** stdio server, auto-spawn, HTTP client, SSE→MCP notification bridge.
6. **Skill content:** SKILL.md + workflow.md + sql-patterns.md. Distill from `src/main/agent/prompts.ts`.
7. **Documentation:** the 11 doc files. GH Pages workflow.
8. **Packaging:** npm publish, Claude Code plugin manifest, release workflow.

## 12. Open questions

None blocking. Specific implementation choices (Fastify vs Hono, sha1 vs blake3, port-pick algorithm) are deferred to writing-plans.

## 13. Out of scope (reaffirmed)

- Remote daemon, multi-user, network exposure.
- Web/desktop UI.
- Provider/LLM management.
- Backwards-compatible migration of Electron app state.
