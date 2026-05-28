# Harness Integration

Matchi mounts as an stdio MCP server. Any harness that speaks MCP can use it. This page collects the config snippets for the major harnesses.

The MCP command is always `matchi-mcp` with no args. The shim handles workspace identification (hashed from `cwd`), daemon autospawn, and bearer-token handshake.

## Claude Code

The plugin install handles this for you:

```bash
claude plugin install github:barockok/matchi-mcp
```

This registers the MCP server and the skill. If you want to configure it manually instead (npm-global install path), edit your Claude Code MCP config:

```json
{
  "mcpServers": {
    "matchi": {
      "command": "matchi-mcp",
      "args": []
    }
  }
}
```

To get the skill without the plugin install, copy `skills/matchi/` from the matchi-mcp source tree into your project's `.claude/skills/` directory (or your global skills directory).

## Cline (VS Code extension)

Cline supports MCP servers via its settings UI or `cline_mcp_settings.json`. Add:

```json
{
  "mcpServers": {
    "matchi": {
      "command": "matchi-mcp",
      "args": [],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Cline does not have a native "skill" concept — the workflow guidance from `skills/matchi/SKILL.md` should be pasted into Cline's custom instructions, or you should preface reconciliation requests with "follow the matchi workflow: recall, inventory, discovery, candidate, run_match, exceptions, report".

## Cursor

Cursor's MCP config (Settings → Cursor Settings → MCP):

```json
{
  "mcpServers": {
    "matchi": {
      "command": "matchi-mcp",
      "args": []
    }
  }
}
```

Restart Cursor after editing. The tools will appear in the chat panel's MCP tool list.

## Continue.dev

Continue's `config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "matchi-mcp",
          "args": []
        }
      }
    ]
  }
}
```

(Adjust based on the current Continue MCP config schema — the key path has shifted across versions.)

## Custom / other harnesses

Any harness that can launch a child process and speak MCP over stdio can mount Matchi. The minimum requirement is:

- Spawn `matchi-mcp` as a child process with no special args.
- Inherit `PATH` (so the spawn can find `matchi-mcp`) and `HOME` (so the shim can resolve `~/.matchi/`).
- Read `stdout`, write `stdin`, with JSON-RPC framing per the MCP spec.

The shim implements the standard MCP server interface from `@modelcontextprotocol/sdk`. There is nothing Matchi-specific in the wire protocol — `tools/list` and `tools/call` work as expected.

## Multiple harnesses, same workspace

You can have Claude Code and Cline both open in the same project directory. They auto-spawn the *same* daemon (only one daemon per `~/.matchi/daemon.json`), and both end up scoped to the same workspace (because `sha1(cwd)` is identical).

This is supported, with one caveat: avoid issuing tool calls that mutate state (`upload_dataset`, `run_match`) from two harnesses *simultaneously*. The daemon serializes writes inside DuckDB, but you may see one call observe the other's partial state. In practice this means: don't run `run_match` from one harness while another is in the middle of `upload_dataset` for the same workspace.

Read-only tools (`list_sources`, `run_sql`, `get_exceptions`, `recall_known_mistakes`) are safe to call concurrently from any number of harnesses.

## Verifying integration

Once the harness is configured, ask its agent:

```
What MCP tools do you have available?
```

A working install lists seven tools: `recall_known_mistakes`, `upload_dataset`, `list_sources`, `load_sheet`, `run_sql`, `run_match`, `get_exceptions`. If the harness doesn't see them, run `matchi doctor` to confirm the binary is on `PATH`, then check the harness's MCP-server logs.

## Env vars in harness configs

Most harnesses let you set environment variables per-server:

```json
{
  "mcpServers": {
    "matchi": {
      "command": "matchi-mcp",
      "args": [],
      "env": {
        "MATCHI_IDLE_MS": "600000",
        "MATCHI_HOME": "/Volumes/work/.matchi"
      }
    }
  }
}
```

These are inherited into the daemon when the shim spawns it. See [05-daemon-ops.md](./05-daemon-ops.md#environment-variables) for the full list.
