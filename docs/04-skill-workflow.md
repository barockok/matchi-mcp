# Skill Workflow

This page is the human-readable explanation of the bundled `matchi` skill. The skill itself lives in [`skills/matchi/SKILL.md`](../skills/matchi/SKILL.md); the long-form patterns live in [`skills/matchi/workflow.md`](../skills/matchi/workflow.md) and [`skills/matchi/sql-patterns.md`](../skills/matchi/sql-patterns.md). All three are activated when the harness loads the plugin.

If you're a user, this page tells you what the agent *should* be doing and why — so you can spot when it's gone off the rails. If you're a contributor, it tells you why the skill is structured the way it is.

## The recipe-aware workflow

```
Step 0    recall_known_mistakes      → prime the agent with prior errors
Step 0.5  list_recipes               → if a saved recipe fits, apply_recipe and skip to Step 5
Step 1    list_sources / upload      → know what's loaded
Step 2    run_sql probes (mandatory) → profile each table
Step 3    candidate matched_sql      → write the join
Step 4    run_match                  → execute, returns inline previews
Step 5    inspect unmatched_*_preview → triage the unmatched (≤200/side inline)
Step 6    report                     → summarize for the user
Step 7    save_recipe (if repeating) → next month is one tool call
```

Each step gates the next. Skipping discovery is the single biggest source of bad reconciliations.

## Step 0 — Recall

The first tool call in every session is `recall_known_mistakes()`. It returns up to ten patterns the agent has previously tripped on in this workspace — things like "forgot to TRIM the ref column on bank.csv" or "treated `posted_at` as a string in the join". Patterns auto-expire after 30 days of not being re-seen.

Why it matters: this is the only mechanism Matchi has for the agent to *learn* from past sessions. The error-memory store records soft errors (`{ok: false, error: {...}}`) per (tool, category), and `recall_known_mistakes` surfaces them. Without this step the agent will happily repeat yesterday's mistake.

## Step 1 — Inventory

`list_sources()` returns everything currently registered in this workspace. If empty, the agent asks the user for paths and calls `upload_dataset(path, alias)`. For a specific XLSX sheet, pass `sheet`. For a snapshot table instead of a zero-copy view, pass `materialize: true`.

Aliases should be short, lowercase, snake_case — they become the DuckDB table/view names directly. `CREATE OR REPLACE` makes re-uploading the same alias idempotent.

## Step 2 — Discovery (mandatory)

This is the step that wins or loses the reconciliation. Match SQL written without discovery fails on:

- type mismatches (a "date" column stored as VARCHAR)
- whitespace and case drift in reference fields
- delimiter variation in references (`INV-001` vs `INV/001`)
- nulls in the join key
- duplicate keys on one side

For each source, the skill prescribes four probes — batch them in one `run_sql({queries: [...]})` call to save round-trips:

1. `SELECT column_name, column_type FROM (DESCRIBE <table>)` — schema and types
2. `SELECT COUNT(*), COUNT(DISTINCT key) FROM <table>` — uniqueness
3. `SELECT MIN(date), MAX(date) FROM <table>` — period coverage
4. `SELECT * FROM <table> LIMIT 5` — eyeball values

The result cap on `run_sql` is **20 rows**. This is a deliberate forcing function: discovery is supposed to be summary statistics and small samples, not data dumps. If the agent finds itself wanting more rows, it should aggregate or group, not raise the limit.

See [`skills/matchi/workflow.md`](../skills/matchi/workflow.md) §1 for the full discovery checklist and §2 for key-selection patterns.

## Step 3 — Candidate match

The `matched_sql` must `SELECT` from the two tables, aliasing them as `a` and `b`. It returns the *matched* rows; `run_match` derives the unmatched on each side.

Start simple — straight `JOIN ... USING (key)` if the data is clean. For most real data, expect to normalize:

```sql
SELECT a.id, b.id
FROM bank a
JOIN gl b
  ON UPPER(TRIM(a.txn_ref)) = UPPER(TRIM(b.txn_ref))
 AND ABS(a.amount - b.amount) < 0.01
 AND ABS(EPOCH(a.posted_at - b.posted_at)) < 86400
```

A key reason amount equality goes in `WHERE` (or as an extra `AND` after the key) and not as the only `ON` condition: it lets you compute `ABS(a.amount - b.amount)` as an output column to diagnose near-misses.

The full pattern library — tolerance windowing, fuzzy keys, multi-leg matches, many-to-one collapse, fx conversion — lives in [`skills/matchi/sql-patterns.md`](../skills/matchi/sql-patterns.md).

## Step 4 — Run match

`run_match({matched_sql, a, b})` materializes the matched relation, derives the unmatched on each side via `WITH _matched AS (...) SELECT * FROM <a> WHERE NOT EXISTS (...)`, exports each unmatched set to CSV under `~/.matchi/workspaces/<hash>/exports/<run_id>/`, and persists the run to the recon store.

Returned numbers to inspect:

- `matched` — the count of joined rows
- `unmatched_a_total`, `unmatched_b_total`
- `unmatched_a_preview`, `unmatched_b_preview` — up to 200 rows per side, inline
- match rate = `matched / max(totalA, totalB)`

The skill's guideline: **if match rate is below ~80%, return to discovery**. Your join is missing something the data has — usually a normalization or a tolerance you haven't accounted for. The targets per domain are in [`skills/matchi/workflow.md`](../skills/matchi/workflow.md) §10.

## Step 5 — Exceptions

The agent reads `unmatched_a_preview` / `unmatched_b_preview` from the `run_match` response (up to 200 rows per side, inline). It groups by theme and proposes remediations:

- widen amount tolerance (FX rounding, WHT/PPh 23, bank fees)
- widen date window (T+1, T+3, settlement lag, cheque clearing)
- fuzzy reference (`LIKE`, regex extract from memo, `levenshtein` ≤ 1)
- normalize counterparty (strip corporate suffixes, alphanumeric fingerprint)
- handle null currencies with `COALESCE`

Then iterate: refine `matched_sql`, run `run_match` again, re-inspect.

## Step 6 — Report

The agent presents:

- total matched, unmatched per side, match rate
- top themes in the exceptions
- recommended next step: widen tolerance, request more data, or accept residual

The skill explicitly prompts the agent to *categorize* the exceptions rather than dump them line-by-line. A 64-row exception list grouped into "20 timing, 7 missing counterpart, 3 amount drift" is actionable; an uncategorized dump is not.

## Reading tool errors

Tools return `{ok: false, error: {code, message, hint?}}` on failure. The skill instructs the agent to read the code and act accordingly — see [03-mcp-tools.md](./03-mcp-tools.md) for the per-tool error tables. Looping on the same error twice is forbidden; the agent should stop and reconsider.

## When to ask the user

The skill lists explicit triggers for asking the user a clarifying question rather than guessing:

- the two sources cover obviously different periods
- a "key" column has more than 20% nulls
- currency or sign conventions are unclear
- an auxiliary table (FX rates, mapping table, whitelist) is implied but not provided
- match rate is dramatically below the domain target and obvious normalizations are exhausted

Frame questions concretely with numbers and proposed remediations, not "what do you want to do?"

## Where to read next

- [`skills/matchi/workflow.md`](../skills/matchi/workflow.md) — long-form patterns, tolerance bands, intercompany, settlement lag, M:1 collapse, volume tactics.
- [`skills/matchi/sql-patterns.md`](../skills/matchi/sql-patterns.md) — DuckDB idioms cookbook (anti-joins, regex, fuzzy similarity, bucketed range joins, QUALIFY, TRY_CAST, common match templates).
- [03-mcp-tools.md](./03-mcp-tools.md) — formal tool API reference.
