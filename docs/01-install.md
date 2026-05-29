# Install

Matchi runs anywhere Node 20+ runs. There is no Electron, no GUI, no system service to register. The daemon is a Node process that auto-spawns on first MCP tool call and self-exits after 30 minutes of idleness.

## Prerequisites

- **Node.js 20 or newer** — verify with `node --version`. Matchi uses native `fetch`, top-level `await`, and ES modules.
- **An MCP-compatible harness** — Claude Code, Cline, Cursor, Continue, or any client that can mount a stdio MCP server.
- **Disk space under `~/.matchi/`** — one DuckDB file per workspace. Plan for the size of your largest dataset plus headroom.

No Python, no Docker, no system-level package required.

## Path 1: Claude Code plugin (recommended)

```bash
claude plugin install github:barockok/matchi
```

This installs the plugin into Claude Code, which:

1. Registers the `matchi` MCP server (command: `matchi`) in your Claude Code config.
2. Installs the bundled `matchi` skill so the agent knows the reconciliation workflow.

Restart your Claude Code session if it was running. Then ask the agent to reconcile two datasets — the agent will activate the skill on its own.

## Path 2: npm global install

```bash
npm install -g matchi
```

This installs two binaries on your `PATH`:

- `matchi` — unified bin. With no args, runs the MCP stdio server (point your harness at this). With a subcommand (`doctor`, `start`, `stop`, `logs`, `gc`), runs the CLI.
- `matchi-daemon` — the HTTP daemon. The shim auto-spawns it; you rarely run it directly.

Then configure your harness. For a generic JSON config (Cline, Continue, custom):

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

See [07-harness-integration.md](./07-harness-integration.md) for harness-specific configs.

## Path 3: From source

```bash
git clone https://github.com/barockok/matchi
cd matchi
npm install
npm run build
npm link
```

`npm link` exposes the same two binaries from your working tree. Useful if you want to hack on the daemon or the shim. Re-run `npm run build` after changing TypeScript sources — the bins import from `dist/`.

## Verify the install

Run `matchi doctor`:

```text
matchi doctor
-------------
MATCHI_HOME: /Users/you/.matchi
daemon:      not running
workspaces:
  (none)
```

A clean machine reports "daemon: not running" — that is correct. The daemon spawns on first MCP tool call from your harness. Once the agent calls anything, `matchi doctor` will show the pid, port, version, uptime, and a list of workspaces.

If `matchi doctor` reports a daemon but says `alive: no (stale pid file)` or `healthy: no`, see [08-troubleshooting.md](./08-troubleshooting.md).

## OS notes

### macOS

- The first time a freshly installed binary runs, Gatekeeper may quarantine it. If `matchi doctor` opens a "cannot be verified" dialog, allow it in **System Settings → Privacy & Security**.
- `~/.matchi/` lives in your home directory. The loopback port the daemon picks is random and bound to `127.0.0.1`, so no firewall dialog appears.

### Linux

- No special steps. The daemon binds `127.0.0.1` on a random unprivileged port.
- If your distro restricts `/tmp` execution, Matchi is unaffected — it does not exec from `/tmp`.

### Windows

- Paths under `%USERPROFILE%\.matchi\` instead of `~/.matchi/`.
- Use PowerShell or any shell where `npm` works. Forward slashes and backslashes both work in tool args because Node normalizes them.
- `matchi doctor` and the other CLI commands work identically.

## Upgrading

```bash
# plugin
claude plugin update matchi

# npm
matchi stop && npm install -g matchi@latest

# source
git pull && npm install && npm run build
```

Always `matchi stop` before upgrading if the daemon is running. The next MCP call will respawn the new version. See [05-daemon-ops.md](./05-daemon-ops.md#upgrading) for details.
