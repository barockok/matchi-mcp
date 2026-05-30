# Troubleshooting

Most issues are diagnosed by `matchi doctor`. Start there. The sections below cover the failures actually seen in practice.

## `matchi doctor` says daemon not running but I started it

The daemon may have exited (idle timeout, crash) without updating `daemon.json`, or `daemon.json` may have been removed.

1. Check whether the pid is alive:
   ```bash
   cat ~/.matchi/daemon.json
   kill -0 <pid> && echo "alive" || echo "dead"
   ```
2. If `daemon.json` is missing entirely, no daemon is running — that's the expected post-idle state. Make any MCP tool call and the shim will spawn one.
3. If `daemon.json` exists but the pid is dead, the file is stale. Run `matchi stop` (which clears stale pid files) or just delete `~/.matchi/daemon.json`.

## "port already in use" on spawn

The daemon binds a random free loopback port via `pickPort` (`src/daemon/lifecycle.ts`) — it asks the kernel for an available port by listening on `:0`. If `pickPort` fails, the kernel refused to give a free port, which is exceptionally rare. The likely cause is system-wide port exhaustion (thousands of leaked sockets).

Diagnostic:

```bash
# Count loopback sockets
lsof -i 4TCP@127.0.0.1 | wc -l
```

If the number is in the tens of thousands, find the misbehaving process. There is no Matchi-side mitigation — `pickPort` is the standard idiom and will work as soon as ports are available.

## Stale `daemon.json`

Symptom: `matchi doctor` reports `alive: no (stale pid file)` or the next MCP call fails because the shim is trying to reach a port that nothing's listening on.

Fix:

```bash
matchi stop          # clears stale pid file
# or
rm ~/.matchi/daemon.json
```

The shim will spawn a fresh daemon on the next tool call.

## DuckDB file corruption

Symptom: tool calls return errors mentioning "database is corrupt" or `data.duckdb` cannot be opened.

DuckDB writes are checkpointed and atomic — corruption usually indicates the host process was killed mid-write or the underlying filesystem mis-handled a flush (network drives, some FUSE mounts).

Recovery:

```bash
matchi stop
# Restore from backup if you have one
cp /backup/data.duckdb ~/.matchi/workspaces/<hash>/data.duckdb

# Or nuke the workspace and re-upload
rm -rf ~/.matchi/workspaces/<hash>
```

Re-uploading is usually faster than fighting a corrupted file. The CSV/XLSX sources are the durable input; the DuckDB file is a rebuildable cache.

## Permissions on `.token`

The bearer token file must be `0600` (owner read/write only). The daemon `chmod`s it on creation. If your `umask` mangled it, or if you copied it from a backup, fix manually:

```bash
chmod 600 ~/.matchi/workspaces/*/.token
```

The daemon doesn't verify the file mode at read time, so a wrong mode won't block functionality — but it does expose the token to other local users. Tighten it.

## Tool returned `dangerous_keyword`

`run_sql` blocks DDL/DML (DROP/DELETE/INSERT/UPDATE/ALTER/CREATE/TRUNCATE/REPLACE/ATTACH/COPY/EXPORT/CALL — see [03-mcp-tools.md](./03-mcp-tools.md#run_sql)). This is a feature: SQL through `run_sql` is read-only by contract.

If you legitimately need to mutate workspace state:

- To load data, use `upload_dataset` (pass `sheet` for a specific XLSX sheet).
- To export, use `run_match` (which writes CSV) or the harness's file-write tools.
- To drop a workspace's table, delete the workspace and re-upload (`rm -rf ~/.matchi/workspaces/<hash>`).

There is no escape hatch in the tool — by design.

## Tool returned `ingestion_failed`

`upload_dataset` wraps DuckDB's `read_csv_auto`, `read_xlsx`, and `read_parquet`. Common causes:

- **Wrong delimiter.** `read_csv_auto` usually figures it out, but unusual delimiters (`|`, `\t` in some locales) can confuse it. Inspect with `head -5 yourfile.csv` — you'll see one line per record only if the parser agrees with the delimiter.
- **Decimal separator.** Indonesian / European locales write `1.234.567,89`; DuckDB's default expects `.` decimal. The auto-loader does its best but sometimes guesses wrong on columns with few rows.
- **Quote mismatch.** Unescaped quotes inside quoted fields confuse the parser.

The error message in the response contains DuckDB's diagnostic. To override the auto-loader's defaults, drop down to `run_sql`-via-the-daemon is not possible (DDL is blocked), so the workaround is:

1. Pre-process the file with `awk`/`sed` or a small Python script to normalize delimiter/decimal.
2. Then `upload_dataset` the cleaned file.

> TODO: a future tool extension may accept `read_csv_auto` overrides (delimiter, decimal_separator, quote, header) as args to `upload_dataset`. Until then, pre-process.

## Tool returned `not_found`

For `upload_dataset`: the file path doesn't exist. Check with `ls -la <path>`. Remember the daemon resolves paths relative to its *own* `cwd`, not the harness's — always pass absolute paths or paths relative to where the daemon was started (typically your harness's cwd at first MCP call).

For `run_match`: the `a` or `b` table doesn't exist in the workspace. Call `list_sources` to see what's loaded.

For `apply_recipe`: `recipe_not_found` means there is no recipe with that name in the current workspace — call `list_recipes` to see what's saved. `sources_missing` means the recipe expects datasets that aren't loaded yet — upload them first under the aliases the recipe asks for.

## Tool returned `match_sql_failed`

The `matched_sql` failed to execute. Common causes:

- The query didn't alias the two sources as `a` and `b`.
- A column reference doesn't exist on one side.
- A type mismatch in the join (string compared to timestamp without `strptime`).

The error hint says `matched_sql must alias datasets as a and b`. The full DuckDB error is in `message`. Read it.

## The agent keeps repeating the same mistake

Two possibilities:

1. The skill isn't loaded. Check that the harness sees the bundled skill (Claude Code: `claude plugin list`). If not, install the plugin or copy `skills/matchi/` into your project.
2. The error memory hasn't accumulated. `recall_known_mistakes` returns up to 10 patterns *that have already happened*. After the first run of a session, patterns from this run join the pool for the next session.

If the agent is ignoring patterns it *does* receive from `recall_known_mistakes`, that's an agent / prompt-following issue, not a Matchi bug. The skill prescribes "do not repeat them this session" but ultimately the model decides.

## The harness can't find `matchi`

`which matchi` should print a path. If it doesn't:

- npm-global install: confirm `npm bin -g` is on your shell's `PATH`.
- From source: confirm `npm link` succeeded and the bins symlinked into your global prefix.
- Plugin: Claude Code calls `matchi` from a vendored location managed by the plugin loader, not your global `PATH`. If `claude plugin list` shows matchi installed, the binary is there.

## Log file is empty

See [05-daemon-ops.md → Logs](./05-daemon-ops.md#logs). The daemon doesn't currently write to `daemon.log`; this is tracked as a TODO.

For interactive debugging, run the daemon in the foreground from a source checkout:

```bash
cd matchi
npm run dev:daemon
```

You'll see Fastify request logs if you enable `logger: true` in `src/daemon/server.ts`.
