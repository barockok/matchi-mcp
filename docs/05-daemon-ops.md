# Daemon Ops

Day-to-day operation of the `matchi-daemon`. For most users there is nothing to do here — the daemon is invisible. This page is for when something feels off, or when you want explicit control.

## Lifecycle in one paragraph

The shim (`matchi`) spawns the daemon (`matchi-daemon`) on the first MCP tool call from your harness. The daemon picks a random free loopback port, writes `~/.matchi/daemon.json` with `{pid, port, startedAt, version}`, and serves HTTP on `127.0.0.1:<port>`. After 30 minutes (configurable) without any request, the daemon gracefully shuts down — close DuckDB, clear `daemon.json`, exit. The next MCP tool call respawns it. DuckDB files on disk are untouched by shutdown.

## State files

Everything lives under `~/.matchi/` (or `%USERPROFILE%\.matchi\` on Windows). Override with the `MATCHI_HOME` environment variable.

```
~/.matchi/
├── daemon.json              # {pid, port, startedAt, version} of the running daemon
├── daemon.log               # only exists if logging is enabled (see below)
└── workspaces/
    └── <cwd-hash>/          # one per project — see 06-workspaces.md
        ├── data.duckdb
        ├── meta.duckdb
        ├── .token           # bearer token, mode 0600
        └── exports/
```

### `daemon.json` shape

```json
{
  "pid": 91234,
  "port": 51823,
  "startedAt": 1716800000000,
  "version": "0.0.1"
}
```

- `pid` — OS process id of the daemon. `kill -0 pid` confirms it's alive.
- `port` — loopback port the daemon is listening on. Random per spawn.
- `startedAt` — epoch ms when this daemon process started.
- `version` — the daemon's package version. Useful for spotting that the running daemon is older than your installed binary.

The shim reads this file to decide whether to spawn. If `pid` is dead or `/healthz` doesn't respond, the shim spawns a new daemon and overwrites the file.

## Environment variables

| Variable          | Default                | Effect                                                                           |
|-------------------|------------------------|----------------------------------------------------------------------------------|
| `MATCHI_HOME`     | `~/.matchi`            | Root of all daemon state, workspaces, tokens.                                    |
| `MATCHI_IDLE_MS`  | `1800000` (30 min)     | Idle timeout in ms. The daemon checks every `min(60_000, idleMs)` ms.            |
| `MATCHI_LOG`      | unset                  | Set to `1` to enable file logging. See [Logs](#logs).                            |

To pass env vars to the auto-spawned daemon, set them in the shell that launches your harness. The shim inherits its env into the spawn.

## CLI

The `matchi` CLI is the explicit-control surface. All commands work whether or not the daemon is running.

### `matchi doctor`

Reports daemon health and workspace inventory.

```text
matchi doctor
-------------
MATCHI_HOME: /Users/you/.matchi
daemon:      pid=91234 port=51823 version=0.0.1
uptime:      342s
alive:       yes
healthy:     yes
workspaces:
  abc123def456  size=12.3KB  mtime=2026-05-29T08:14:22.000Z
```

Exits 0 if the daemon is healthy or not running at all (both are "clean" states). Exits 1 if `daemon.json` exists but the daemon isn't responding — that's an inconsistent state and means the pid file is stale or the daemon hung.

### `matchi start`

Spawns the daemon if it isn't already running. Idempotent: no-op when the daemon is healthy.

```text
$ matchi start
daemon running: pid=91234 port=51823 version=0.0.1
```

You rarely need this — the shim auto-spawns on demand.

### `matchi stop`

Sends `POST /v1/shutdown` to the running daemon. Waits up to 5 seconds for the pid to disappear, cleans up any stale `daemon.json`.

```text
$ matchi stop
stopped (pid=91234)
```

If the daemon is already gone but `daemon.json` lingered, prints `not running (cleared stale pid file)`.

### `matchi logs [-f|--follow]`

Tails `~/.matchi/daemon.log`. If the file doesn't exist, prints:

```text
logging disabled — set MATCHI_LOG=1 to enable
```

> TODO: the daemon does not currently write to `daemon.log` even when `MATCHI_LOG=1`. The `matchi logs` command can tail the file once a future change wires the daemon's `pino` logger to it. For now the only way to capture daemon output is to run `matchi-daemon` in the foreground.

### `matchi gc [--older-than DURATION]`

Removes workspace directories whose `data.duckdb` mtime is older than the threshold. Default `30d`. Units: `d` (days), `w` (weeks), `m` (30-day months).

```text
$ matchi stop                          # gc refuses to run while daemon is up
$ matchi gc --older-than 14d
removed abc123def456 (mtime=2026-05-10T12:00:00.000Z)
gc complete: 1 workspace(s) removed
```

`gc` refuses to run if the daemon is up — too easy to delete state mid-write. Stop the daemon first.

### `matchi help`

Prints the command list.

## Logs

Daemon log file: `~/.matchi/daemon.log`.

The daemon does not write to this file by default. To enable file logging, set `MATCHI_LOG=1` in the environment that spawns the daemon, then start it explicitly. See the TODO under `matchi logs` above.

For interactive debugging, run the daemon in the foreground:

```bash
matchi stop                 # ensure no detached daemon is running
node $(which matchi-daemon)  # or: npm run dev:daemon from a source checkout
```

Stdout will show Fastify's request log if you build the server with `logger: true` (currently disabled by default in `src/daemon/server.ts`).

## Upgrading

The daemon and the shim should always be the same version. Upgrade steps:

```bash
matchi stop                              # close DuckDB cleanly
npm install -g matchi@latest         # or: claude plugin update matchi
```

Next MCP tool call from your harness will respawn the new daemon. DuckDB files and the per-workspace `.token` survive the upgrade.

If `matchi doctor` shows a `version` older than what you just installed, the running daemon is the previous version — stop it.

## Killing it from outside the CLI

If `matchi stop` is unavailable (binary missing, hung daemon), `kill <pid>` works. Read the pid from `~/.matchi/daemon.json`:

```bash
kill $(jq -r .pid ~/.matchi/daemon.json)
rm ~/.matchi/daemon.json
```

The `daemon.json` cleanup matters — a stale file confuses the next shim spawn for a moment before it notices the pid is dead.

## What survives a crash

If the daemon dies hard (`SIGKILL`, OOM, kernel panic), `daemon.json` is left orphaned. The shim handles this on the next call: it reads the file, finds the pid is dead, and spawns a fresh daemon. DuckDB writes are checkpointed by DuckDB itself, so the on-disk state is consistent. The in-memory match results for the most recent run, however, are lost — re-run `run_match` to repopulate.
