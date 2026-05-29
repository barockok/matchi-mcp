# matchi

> Dataset reconciliation, mounted as an MCP server. Bring your own agentic harness.

`matchi` exposes a set of reconciliation tools (load tabular sources, run
DuckDB SQL, execute match-and-diff workflows, surface exceptions) over the
Model Context Protocol. It is designed for finance, ops, and data teams who
want an LLM agent to chase down "why don't these two ledgers tie?" — without
giving up control of their data or their harness. The MCP server is a thin
stdio shim; the real work happens in a local DuckDB-backed daemon that lives
under `~/.matchi/`, so multiple harnesses (Claude Code, Cline, Cursor,
Continue, custom) can share the same workspace and dataset cache.

## Install (Claude Code)

Inside Claude Code:

```
/plugin marketplace add barockok/matchi
/plugin install matchi@matchi-marketplace
```

Then install the MCP server binary globally so the plugin's stdio command
resolves on `$PATH`. Install directly from the GitHub release tarball or
from the repo:

```bash
# Option A — latest tagged release tarball
npm install -g https://github.com/barockok/matchi/releases/latest/download/matchi.tgz

# Option B — straight from the git repo
npm install -g github:barockok/matchi
```

Reload plugins (`/plugin reload` or restart Claude Code). This registers the
`matchi` MCP server and the bundled `matchi` skill, which teaches the agent
the reconciliation workflow (discover sources, profile, propose a match key,
run, triage exceptions).

## Install (any MCP harness)

Install the CLI globally from GitHub, then point your harness at the stdio
command:

```bash
npm install -g github:barockok/matchi
```

Configure your harness to launch `matchi` as a stdio MCP server. For a
generic JSON config (Cline, Continue, custom):

```json
{
  "mcpServers": {
    "matchi": {
      "command": "matchi",
      "args": []
    }
  }
}
```

The shim auto-spawns the daemon on first tool call; no separate service to
manage.

## What it does

Seven MCP tools:

- `upload_dataset` — load a local CSV or XLSX into the workspace DuckDB.
- `list_sources` — enumerate datasets registered in the current workspace.
- `load_sheet` — ingest a specific sheet from an XLSX file.
- `run_sql` — execute DuckDB SQL (batched up to 10, row-capped at 20,
  dangerous keywords blocked).
- `run_match` — execute a reconciliation: matched rows + derived unmatched
  set, with progress events.
- `get_exceptions` — paginate through unmatched rows from a given match run.
- `recall_known_mistakes` — top-10 error patterns the agent previously
  tripped on in this workspace.

## How it works

The MCP entrypoint (`matchi`) is a stdio shim. On first request it
ensures a local daemon is running and forwards JSON-RPC over a Unix socket.
The daemon owns a DuckDB instance per workspace, keyed by
`sha1(cwd)[:12]`, stored under `~/.matchi/workspaces/<key>/`. The daemon
self-exits after an idle timeout, so it costs nothing when not in use.
Workspaces are isolated, so two projects on the same machine never see each
other's data.

## CLI

- `matchi doctor` — check daemon health, socket, DuckDB engine, workspace dir.
- `matchi start` — start the daemon explicitly (usually unnecessary; the shim
  spawns it).
- `matchi stop` — stop the running daemon.
- `matchi gc [--older-than 30d]` — garbage-collect stale workspace
  directories.

## Configuration

| Env var          | Default      | Description                                                |
|------------------|--------------|------------------------------------------------------------|
| `MATCHI_HOME`    | `~/.matchi`  | Root of daemon state, workspaces, tokens, logs.            |
| `MATCHI_IDLE_MS` | `1800000`    | Idle timeout (ms) before the daemon self-exits.            |
| `MATCHI_LOG`     | `info`       | Log level: `trace`, `debug`, `info`, `warn`, `error`.      |

## Documentation

See `docs/` for architecture, tool specs, troubleshooting, and harness
integration guides. (Deep dives land alongside the first tagged release.)

## License

MIT — see `LICENSE`.
