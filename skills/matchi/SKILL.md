---
name: matchi
description: Use when reconciling, matching, or analyzing two or more tabular datasets — bank vs GL, AR vs invoices, marketplace vs settlement reports, intercompany positions, AP. Triggers on "reconcile", "match these datasets", "find unmatched", "exceptions", "recon", or any explicit cross-dataset reconciliation request. Tools live in the matchi MCP server.
---

# Matchi Reconciliation Workflow

Matchi tools (via the matchi MCP server):
- `upload_dataset(path, alias?)` — load a CSV or XLSX file into the workspace DuckDB
- `list_sources()` — list datasets registered for this workspace
- `load_sheet(path, sheet, alias?)` — load a specific sheet from an XLSX
- `run_sql(sql | queries[])` — read-only DuckDB SQL (20-row cap, no DDL/DML)
- `run_match(matched_sql, a, b)` — execute the recon and persist matched + unmatched
- `get_exceptions(match_run_id, side, page)` — page through unmatched rows
- `recall_known_mistakes()` — top patterns you tripped on previously in this workspace

The workspace is scoped to the current working directory. Datasets persist across sessions until garbage-collected.

## Step 0 — Recall

Always call `recall_known_mistakes` first. Read the returned patterns. Do not repeat them this session. If empty, that means you have no prior history here.

## Step 1 — Inventory

Call `list_sources`. If empty, ask the user for file paths and call `upload_dataset` (or `load_sheet` for xlsx with multiple sheets) for each. Pick short, lowercase, snake_case aliases — they become DuckDB table names.

## Step 2 — Discovery (mandatory)

For each source, run small `run_sql` probes before proposing any match. Never skip this — match SQL written without discovery typically fails on type mismatches, leading whitespace, dates stored as strings, or unexpected nulls.

For each table, run:
- `SELECT column_name, column_type FROM (DESCRIBE <table>)` — confirm types
- `SELECT COUNT(*), COUNT(DISTINCT <candidate_key>) FROM <table>` — uniqueness
- `SELECT MIN(<date_col>), MAX(<date_col>) FROM <table>` — date range
- `SELECT * FROM <table> LIMIT 5` — sample values

Batch these with `run_sql({queries: [...]})` to save round-trips.

## Step 3 — Candidate match

Write a `matched_sql` joining the two sources. The query must SELECT from the two source tables aliased as `a` and `b`. Start simple:

```sql
SELECT a.id, b.id
FROM bank_statement AS a
JOIN gl_postings AS b USING (txn_ref)
```

For real-world data you almost always need normalization:

```sql
SELECT a.id, b.id
FROM bank_statement AS a
JOIN gl_postings AS b
  ON UPPER(TRIM(a.txn_ref)) = UPPER(TRIM(b.txn_ref))
 AND ABS(a.amount - b.amount) < 0.01
 AND ABS(EPOCH(a.posted_at - b.posted_at)) < 86400
```

See `sql-patterns.md` for tolerance windowing, fuzzy keys, multi-leg matches, and many-to-one collapses.

## Step 4 — Run match

Call `run_match({matched_sql, a, b})`. Inspect:
- `matched` count
- `unmatched_a`, `unmatched_b` counts
- match rate (matched / max(rows_a, rows_b))

If match rate is below ~80%, return to discovery — your join condition is missing something the data has.

## Step 5 — Exceptions

Call `get_exceptions(match_run_id, side, page)` for each side. Look at the unmatched rows. Common remediations:
- widen amount tolerance (cents-of-cents)
- widen date window (T+1, T+3, settlement lag)
- fuzzy reference (LIKE pattern, regex extract, levenshtein on shorter keys)
- normalize counterparty/payee with `regexp_replace`
- handle null currencies with `COALESCE`

Iterate: refine `matched_sql`, re-run, re-inspect.

## Step 6 — Report

Summarize: total matched, unmatched per side, match rate, top exception themes, recommended next step (request more data, agree tolerance with user, accept exceptions and write off).

## When in doubt

- Read `workflow.md` for detailed patterns (multi-leg, intercompany, settlement lag, M:1 collapse).
- Read `sql-patterns.md` for DuckDB idioms (windowed joins, regexp, fuzzy similarity, list aggregation).
- If a tool returns `{ok: false, error: {code, message}}`, READ the error code — it tells you whether to retry, change args, or stop.
