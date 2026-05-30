# Workspaces

A *workspace* is the per-project storage Matchi uses to keep loaded datasets, recon results, recipes, and error memory. Each harness `cwd` maps to exactly one workspace.

## cwd to hash

The workspace hash is the first 12 hex characters of `sha1(cwd)`:

```ts
// src/shared/hash.ts
export function workspaceHash(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}
```

The shim computes the hash from `process.cwd()` and includes it as the URL path segment when calling the daemon. The agent never sees the hash; the daemon never sees the cwd.

A few consequences worth knowing:

- **Symlinks matter.** Resolved vs unresolved paths hash differently. `/Users/me/work/proj` and `/Volumes/Home/me/work/proj` produce different workspaces even if one is a symlink to the other.
- **Trailing slash matters.** `/Users/me/proj` and `/Users/me/proj/` hash differently. Node's `process.cwd()` does not emit a trailing slash on any platform, so in practice this is a non-issue — but if you ever set `cwd` manually, mind it.
- **Hash collisions are non-existent** at this scale. SHA-1 truncated to 48 bits across the number of project directories on one machine is comfortably collision-free.

## Disk layout

```
~/.matchi/workspaces/<hash>/
├── data.duckdb       # loaded datasets, temp tables, match outputs
├── meta.duckdb       # sources registry, recon runs, recipes, error patterns
├── .token            # 64-hex bearer token, mode 0600
└── exports/
    └── <run_id>/
        ├── unmatched_<table_a>.csv
        └── unmatched_<table_b>.csv
```

- **`data.duckdb`** holds the actual data tables — one table per uploaded source plus any temp tables `run_match` materializes during matching. Sizable.
- **`meta.duckdb`** holds metadata: the `sources` registry that powers `list_sources`, the recon-store tables (runs, audit, persisted runs), the recipe-store tables, and the error-memory-store tables. Small.
- **`.token`** is a 32-byte (64 hex chars) random token generated on first workspace touch. The daemon `chmod`s it to `0600`. The shim reads it for each call's `Authorization: Bearer <token>` header.
- **`exports/`** contains the CSV exports written by `run_match` — one subdirectory per run.

## What to commit

Nothing. Workspaces are local state. Add `~/.matchi/` to your gitignore mental model — but there's no need to add anything to your repo's `.gitignore`, because Matchi never writes inside your repo. All state lives under `MATCHI_HOME`.

## What to back up

If you care about reconciliation history surviving a machine wipe:

```bash
# Back up one workspace
cp -r ~/.matchi/workspaces/<hash>/ /path/to/backup/

# Back up everything
cp -r ~/.matchi/ /path/to/backup/
```

Specifically:

- `data.duckdb` — keeps the registered datasets (views over local files, plus any materialized snapshots).
- `meta.duckdb` — recon-run history, saved recipes, and accumulated error memory.
- `exports/` — the CSV deliverables for the unmatched sides. Treat these as the durable artifact if you only care about results, not history.

You can ignore `.token` — it gets regenerated on first touch of a fresh workspace.

**Daemon must be stopped before copying** the duckdb files — DuckDB holds an exclusive lock while the daemon is running.

## Inspecting a workspace from the CLI

`matchi doctor` lists every workspace with its on-disk size and last-modified time:

```text
workspaces:
  abc123def456  size=12.3KB  mtime=2026-05-29T08:14:22.000Z
  789def012345  size=4.7MB   mtime=2026-05-28T17:02:11.000Z
```

If you want to map a hash back to a project, the simplest path is to `cd` into the suspected project and check `matchi doctor`'s output — the most-recently-touched workspace is almost always the one you just used. Otherwise you'd have to recompute hashes yourself from a list of candidate cwds.

## Garbage collection

```bash
matchi stop                            # gc refuses to run while daemon is up
matchi gc --older-than 30d             # default
matchi gc --older-than 2w
matchi gc --older-than 1m              # 30 days
```

`gc` removes workspaces whose `data.duckdb` mtime is older than the threshold. If `data.duckdb` is missing, the directory's own mtime is used. Workspaces with recent activity are never touched.

For a manual purge:

```bash
matchi stop
rm -rf ~/.matchi/workspaces/<hash>     # one workspace
rm -rf ~/.matchi/                      # everything (DESTRUCTIVE)
```

## Multiple projects, one daemon

The daemon serves every workspace from the same process. Two projects open in two different Claude Code sessions share the same daemon — they get different workspaces (different hashes), different DuckDB files, different bearer tokens.

This is fine for normal use. The only contention is RAM: each open workspace keeps its DuckDB engines in memory until idle shutdown. If you've touched many workspaces in a session, the daemon's RSS will reflect that. The idle timeout cleans this up automatically.

## Concurrent access from multiple harnesses

If two harness processes share the same `cwd` (e.g. Claude Code and Cline both pointed at the same directory), they auto-spawn the same daemon and both end up writing to the same `data.duckdb` and `meta.duckdb`. DuckDB serializes writes inside one process, so concurrent writes from the *same* daemon are safe.

What is **not** safe: two daemons trying to open the same workspace at the same time. The shim is careful to spawn at most one daemon per machine via `~/.matchi/daemon.json`, so in practice this can't happen. But if you've manually started a second daemon (`matchi-daemon` directly, ignoring `daemon.json`), you can corrupt files. Don't do that.
