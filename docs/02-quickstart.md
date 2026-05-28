# Quickstart

A five-minute end-to-end reconciliation: bank statement vs general ledger. Assumes you have Claude Code with the matchi plugin installed; the same flow works in any MCP harness.

## Scenario

You have two CSV files in your project directory:

- `bank.csv` — daily bank transactions for January.
- `gl.csv` — GL postings to the cash account for the same period.

They should agree, but you suspect 30 lines won't reconcile. You want a definitive matched/unmatched split with the unmatched rows exported to CSV.

## Step 1: Install (if you haven't)

```bash
claude plugin install github:barockok/matchi-mcp
```

See [01-install.md](./01-install.md) for other harnesses.

## Step 2: Open your project in Claude Code

```bash
cd /path/to/your/project
claude
```

The workspace hash is derived from the current working directory, so always open Claude Code from the project root — that's how Matchi keeps each project's data isolated. See [06-workspaces.md](./06-workspaces.md).

## Step 3: Ask the agent

```
> Reconcile bank.csv against gl.csv. Use the txn_ref column.
```

The matchi skill activates on the words "reconcile" and "match". A typical agent transcript follows. Your exact wording will differ, but the tool calls are stable.

## Step 4: The agent runs the workflow

The skill prescribes six steps. Watch the tool calls fly by.

**Recall (Step 0).** The agent calls `recall_known_mistakes()` to load any patterns from prior sessions in this workspace.

```json
{"ok": true, "data": {"patterns": []}}
```

Empty on a fresh workspace — nothing to recall yet.

**Inventory (Step 1).** `list_sources()` returns nothing on a fresh workspace, so the agent uploads each file:

```json
upload_dataset({"path": "./bank.csv", "alias": "bank"})
→ {"ok": true, "data": {"table_name": "csv_bank_xxxxxxxx", "rows": 247, "columns": [
     {"name": "id", "type": "BIGINT"},
     {"name": "posted_at", "type": "TIMESTAMP"},
     {"name": "txn_ref", "type": "VARCHAR"},
     {"name": "amount", "type": "DOUBLE"}
   ]}}
```

```json
upload_dataset({"path": "./gl.csv", "alias": "gl"})
→ {"ok": true, "data": {"table_name": "csv_gl_xxxxxxxx", "rows": 251, "columns": [...]}}
```

**Discovery (Step 2).** The agent batches discovery probes through `run_sql`:

```json
run_sql({"queries": [
  {"sql": "SELECT COUNT(*), COUNT(DISTINCT txn_ref) FROM csv_bank_xxxxxxxx", "description": "bank uniqueness"},
  {"sql": "SELECT COUNT(*), COUNT(DISTINCT txn_ref) FROM csv_gl_xxxxxxxx",   "description": "gl uniqueness"},
  {"sql": "SELECT MIN(posted_at), MAX(posted_at) FROM csv_bank_xxxxxxxx",    "description": "bank range"},
  {"sql": "SELECT * FROM csv_bank_xxxxxxxx LIMIT 5",                         "description": "bank sample"},
  {"sql": "SELECT * FROM csv_gl_xxxxxxxx LIMIT 5",                           "description": "gl sample"}
]})
```

The agent sees that `txn_ref` in bank has trailing whitespace and mixed case, while `gl` is clean. So normalization is needed.

**Candidate match (Step 3) and run_match (Step 4).**

```json
run_match({
  "matched_sql": "SELECT a.id AS bank_id, b.id AS gl_id FROM csv_bank_xxxxxxxx AS a JOIN csv_gl_xxxxxxxx AS b ON UPPER(TRIM(a.txn_ref)) = UPPER(TRIM(b.txn_ref)) AND ABS(a.amount - b.amount) < 0.01",
  "a": "csv_bank_xxxxxxxx",
  "b": "csv_gl_xxxxxxxx"
})
→ {"ok": true, "data": {
     "matchRunId": "run_...",
     "matched": 217,
     "unmatchedA": 30,
     "unmatchedB": 34,
     "totalExceptions": 64,
     "unmatchedAFile": "/Users/you/.matchi/workspaces/<hash>/exports/run_.../unmatched_csv_bank_xxxxxxxx.csv",
     "unmatchedBFile": "/Users/you/.matchi/workspaces/<hash>/exports/run_.../unmatched_csv_gl_xxxxxxxx.csv",
     "sampleMatched": [...],
     "sampleExceptionsA": [...],
     "sampleExceptionsB": [...]
   }}
```

Match rate is `217/247 ≈ 88%`. The skill says: if match rate is below 80% return to discovery, otherwise inspect exceptions.

**Exceptions (Step 5).**

```json
get_exceptions({"match_run_id": "run_...", "side": "a", "page": 0, "page_size": 50})
→ {"ok": true, "data": {"exceptions": [...30 rows...], "total": 30}}
```

The agent groups the unmatched by theme — say, 20 rows that look like settlement-lag (`posted_at` differs by 1-3 days), 7 with no GL counterpart, 3 with amount drift > 0.01.

**Report (Step 6).** The agent presents:

```
Match rate: 88% (217/247).
Unmatched on bank: 30
  - 20 settlement-lag (T+1 to T+3) — suggest widening date window
  - 7 missing GL counterpart — likely unbooked
  - 3 amount drift > 0.01 — check for bank fees deducted at source
Unmatched on GL: 34 (probably the mirror of the 30, plus 4 GL-only entries — needs review).
```

You decide whether to widen the date window, accept the drift, or follow up on the unbooked items.

## Where the result lives on disk

```
~/.matchi/workspaces/<hash>/
├── data.duckdb              # the loaded sources + temp tables
├── meta.duckdb              # sources registry, recon runs, error memory
├── .token                   # workspace bearer token (mode 0600)
└── exports/
    └── <run_id>/
        ├── unmatched_csv_bank_xxxxxxxx.csv
        └── unmatched_csv_gl_xxxxxxxx.csv
```

The CSV files are the authoritative deliverable for the unmatched side — hand them off to whoever needs to follow up.

## What just happened

- The daemon spawned automatically on the first tool call.
- Datasets persist across Claude Code restarts. If you close Claude and come back tomorrow, `list_sources` still returns these two tables.
- The recon run is persisted. `get_exceptions` works any time within the workspace.
- After 30 minutes of no activity the daemon exits cleanly. The next call respawns it. DuckDB files remain on disk.

## Next steps

- Tool reference: [03-mcp-tools.md](./03-mcp-tools.md)
- The full skill workflow with rationale: [04-skill-workflow.md](./04-skill-workflow.md)
- Garbage-collect old workspaces: see [06-workspaces.md](./06-workspaces.md#garbage-collection).
