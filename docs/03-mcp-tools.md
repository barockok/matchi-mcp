# MCP Tool Reference

Matchi exposes seven tools via the MCP server. All tools accept an optional `description` string used for progress events and human-readable labels. All return either `{ok: true, data: {...}}` or `{ok: false, error: {code, message, hint?}}`.

The schemas below are the Zod schemas in `src/daemon/tools/*.ts`. The MCP-exposed JSON Schema is generated from these via `zod-to-json-schema`.

## Index

- [`recall_known_mistakes`](#recall_known_mistakes)
- [`upload_dataset`](#upload_dataset)
- [`list_sources`](#list_sources)
- [`load_sheet`](#load_sheet)
- [`run_sql`](#run_sql)
- [`run_match`](#run_match)
- [`get_exceptions`](#get_exceptions)

---

## `recall_known_mistakes`

Return the top-10 error patterns the agent has tripped on previously in this workspace. Call once at the start of every session.

### Args

```ts
{}  // no args
```

### Returns

```ts
{
  ok: true,
  data: {
    patterns: Array<{
      tool_name: string
      error_category: 'syntax' | 'not_found' | 'validation' | 'other'
      count: number
      last_seen: number    // epoch ms
      hint?: string
      // additional fields from ErrorMemoryStore (see source)
    }>
  }
}
```

### Errors

None in normal operation — returns `{patterns: []}` on a fresh workspace.

### Examples

```json
// Fresh workspace
{"ok": true, "data": {"patterns": []}}

// After some sessions
{"ok": true, "data": {"patterns": [
  {"tool_name": "run_sql", "error_category": "syntax", "count": 3, "last_seen": 1716800000000,
   "hint": "Forgot to wrap timestamp diff in EPOCH(...)"}
]}}
```

---

## `upload_dataset`

Load a local CSV or XLSX file into the workspace DuckDB. Registers it in the workspace `sources` table.

### Args

```ts
{
  path: string,           // absolute or cwd-relative path to .csv or .xlsx
  alias?: string,         // optional table-name hint, snake_case recommended
  description?: string    // optional progress-event label
}
```

### Returns

```ts
{
  ok: true,
  data: {
    table_name: string,         // generated: csv_<alias>_<8hex>  or  xlsx_<alias>_<8hex>
    rows: number,
    columns: Array<{name: string, type: string}>
  }
}
```

### Errors

| code                 | when                                                          |
|----------------------|---------------------------------------------------------------|
| `not_found`          | `path` does not exist on disk                                 |
| `unsupported_format` | extension is not `.csv` or `.xlsx`                            |
| `ingestion_failed`   | DuckDB `read_csv_auto`/`read_xlsx` threw (message in payload) |

### Examples

```json
// Happy path
upload_dataset({"path": "./bank.csv", "alias": "bank"})
→ {"ok": true, "data": {
     "table_name": "csv_bank_3f9c0a12",
     "rows": 247,
     "columns": [
       {"name": "id", "type": "BIGINT"},
       {"name": "txn_ref", "type": "VARCHAR"},
       {"name": "amount", "type": "DOUBLE"}
     ]
   }}

// Error: bad path
upload_dataset({"path": "./missing.csv"})
→ {"ok": false, "error": {"code": "not_found", "message": "file ./missing.csv does not exist"}}
```

For XLSX files with multiple sheets, prefer [`load_sheet`](#load_sheet) so you can name the sheet explicitly. `upload_dataset` on an XLSX loads the first sheet via `read_xlsx`.

---

## `list_sources`

Enumerate datasets registered in the current workspace.

### Args

```ts
{
  description?: string
}
```

### Returns

```ts
{
  ok: true,
  data: {
    sources: Array<{
      table: string,
      alias: string | null,
      rows: number,
      columns: Array<{name: string, type: string}>,
      uploaded_at: number | null   // epoch ms
    }>
  }
}
```

Sources are returned ordered by `uploaded_at DESC`. Tables that exist in the registry but no longer in DuckDB are silently skipped.

### Errors

None in normal operation.

### Examples

```json
// Empty workspace
{"ok": true, "data": {"sources": []}}

// After two uploads
{"ok": true, "data": {"sources": [
  {"table": "csv_gl_1a2b3c4d", "alias": "gl", "rows": 251, "columns": [...], "uploaded_at": 1716800100000},
  {"table": "csv_bank_3f9c0a12", "alias": "bank", "rows": 247, "columns": [...], "uploaded_at": 1716800000000}
]}}
```

---

## `load_sheet`

Load a specific sheet from an XLSX file. Use this when the workbook has multiple sheets.

### Args

```ts
{
  path: string,         // .xlsx file path
  sheet: string,        // sheet name (case-sensitive, as it appears in Excel)
  alias?: string,
  description?: string
}
```

### Returns

```ts
{
  ok: true,
  data: {
    table_name: string,    // xlsx_<alias>_<8hex>; defaults to "<basename>_<sheet>" if no alias
    rows: number,
    columns: Array<{name: string, type: string}>
  }
}
```

### Errors

| code                 | when                                                          |
|----------------------|---------------------------------------------------------------|
| `not_found`          | `path` does not exist                                         |
| `unsupported_format` | extension is not `.xlsx`                                      |
| `ingestion_failed`   | DuckDB `read_xlsx` threw — usually wrong sheet name           |

### Examples

```json
load_sheet({"path": "./Q1.xlsx", "sheet": "Bank Jan", "alias": "bank_jan"})
→ {"ok": true, "data": {"table_name": "xlsx_bank_jan_5e7f1903", "rows": 247, "columns": [...]}}
```

---

## `run_sql`

Execute one read-only DuckDB query, or a batch of up to 10. Results are capped at 20 rows and 120 characters per string field. Dangerous keywords (`DROP`, `DELETE`, `INSERT`, `UPDATE`, `ALTER`, `CREATE`, `TRUNCATE`, `REPLACE`, `ATTACH`, `COPY`, `EXPORT`, `CALL`) are blocked.

### Args

Exactly one of `sql` or `queries` must be provided.

```ts
// Single
{
  sql: string,
  limit?: number,         // 1..20, default 20
  count_only?: boolean,   // if true, returns just {totalRows}
  description?: string
}

// Batch (up to 10)
{
  queries: Array<{
    sql: string,
    limit?: number,
    count_only?: boolean,
    description?: string
  }>,
  description?: string    // top-level label
}
```

Batch payload is capped at ~20 KB; rows in later results are progressively truncated if the cap is reached.

### Returns

```ts
// Single, normal
{ok: true, data: {rows: Array<Record<string, unknown>>, totalRows: number, truncated: boolean}}

// Single, count_only
{ok: true, data: {totalRows: number}}

// Batch
{ok: true, data: {
  results: Array<{
    index: number,
    sql: string,
    description: string | null,
    status: 'success' | 'error',
    rows: Record<string, unknown>[],
    totalRows: number,
    truncated: boolean,
    error: string | null
  }>,
  totalQueries: number,
  successCount: number,
  errorCount: number
}}
```

### Errors

| code                | when                                                                    |
|---------------------|-------------------------------------------------------------------------|
| `dangerous_keyword` | SQL matches the blocked-keyword regex                                   |
| `query_failed`      | parse or execution error (message includes DuckDB's diagnostic)         |
| `batch_too_large`   | `queries` array empty or exceeds 10                                     |

Per-query errors in batch mode are returned in the per-result `error` field — the overall envelope is still `ok: true`.

### Examples

```json
// Single happy path
run_sql({"sql": "SELECT COUNT(*) AS n FROM csv_bank_3f9c0a12"})
→ {"ok": true, "data": {"rows": [{"n": 247}], "totalRows": 1, "truncated": false}}

// Batch with one failure
run_sql({"queries": [
  {"sql": "DESCRIBE csv_bank_3f9c0a12"},
  {"sql": "SELECT * FROM nonexistent"}
]})
→ {"ok": true, "data": {
     "results": [
       {"index": 0, "status": "success", "rows": [...], ...},
       {"index": 1, "status": "error", "error": "...Table with name nonexistent does not exist!...", ...}
     ],
     "totalQueries": 2, "successCount": 1, "errorCount": 1
   }}

// Dangerous keyword blocked
run_sql({"sql": "DELETE FROM csv_bank_3f9c0a12"})
→ {"ok": false, "error": {"code": "dangerous_keyword", "message": "Query contains disallowed keywords..."}}
```

---

## `run_match`

Execute a reconciliation. The agent provides a SQL query that joins two tables (aliased as `a` and `b`) into a "matched" relation; the tool derives the unmatched on each side via `NOT EXISTS` on the shared columns, exports each unmatched set to CSV inside the workspace, and persists the run.

### Args

```ts
{
  matched_sql: string,    // must SELECT from the two tables aliased as a and b
  a: string,              // identifier of table A (must match /^[a-zA-Z0-9_]+$/)
  b: string,              // identifier of table B
  description?: string
}
```

The `matched_sql` is materialized into a temp table to inspect which columns came from `a` vs `b`. Columns shared between `matched` and the source tables form the implicit anti-join keys. If no shared columns exist on a side, the entire side is treated as unmatched.

### Returns

```ts
{
  ok: true,
  data: {
    matchRunId: string,
    matched: number,
    unmatchedA: number,
    unmatchedB: number,
    totalExceptions: number,
    unmatchedAFile: string | null,   // absolute path to exported CSV, or null if 0 unmatched
    unmatchedBFile: string | null,
    sampleMatched: Record<string, unknown>[],       // up to 5
    sampleExceptionsA: Record<string, unknown>[],   // up to 3
    sampleExceptionsB: Record<string, unknown>[]
  }
}
```

Progress events stream over the SSE channel `/v1/workspaces/:hash/stream?id=<jobId>` with phases: `validating`, `matching`, `computing_unmatched`, `persisting`. The MCP shim allocates a job id per call but does not yet relay these events back to the harness — see [09-architecture.md](./09-architecture.md).

### Errors

| code                 | when                                                            |
|----------------------|-----------------------------------------------------------------|
| `invalid_identifier` | `a` or `b` contains non-identifier characters                   |
| `not_found`          | `a` or `b` table does not exist                                 |
| `match_sql_failed`   | the `matched_sql` failed to execute (hint asks for `a`/`b` aliases) |

### Examples

```json
run_match({
  "matched_sql": "SELECT a.id AS bank_id, b.id AS gl_id, a.txn_ref FROM csv_bank_3f9c0a12 a JOIN csv_gl_1a2b3c4d b ON UPPER(TRIM(a.txn_ref)) = UPPER(TRIM(b.txn_ref)) AND ABS(a.amount - b.amount) < 0.01",
  "a": "csv_bank_3f9c0a12",
  "b": "csv_gl_1a2b3c4d"
})
→ {"ok": true, "data": {
     "matchRunId": "run_01HXY...",
     "matched": 217,
     "unmatchedA": 30,
     "unmatchedB": 34,
     "totalExceptions": 64,
     "unmatchedAFile": "/Users/you/.matchi/workspaces/abc123def456/exports/run_01HXY.../unmatched_csv_bank_3f9c0a12.csv",
     "unmatchedBFile": "/Users/you/.matchi/workspaces/abc123def456/exports/run_01HXY.../unmatched_csv_gl_1a2b3c4d.csv",
     "sampleMatched": [...5...],
     "sampleExceptionsA": [...3...],
     "sampleExceptionsB": [...3...]
   }}

// Error: SQL doesn't alias correctly
run_match({"matched_sql": "SELECT * FROM csv_bank_3f9c0a12", "a": "csv_bank_3f9c0a12", "b": "csv_gl_1a2b3c4d"})
→ {"ok": false, "error": {
     "code": "match_sql_failed",
     "message": "...",
     "hint": "matched_sql must alias datasets as a and b"
   }}
```

---

## `get_exceptions`

Page through unmatched rows from a prior `run_match`. The run id you got back from `run_match` is the handle.

### Args

```ts
{
  match_run_id: string,
  side?: 'a' | 'b' | 'all',   // default 'all'
  page?: number,              // 0-indexed, default 0
  page_size?: number,         // 1..200, default 50
  description?: string
}
```

### Returns

```ts
{
  ok: true,
  data: {
    match_run_id: string,
    side: 'a' | 'b' | 'all',
    page: number,
    page_size: number,
    exceptions: Array<Record<string, unknown>>,
    total: number
  }
}
```

### Errors

| code        | when                                          |
|-------------|-----------------------------------------------|
| `not_found` | `match_run_id` does not refer to a known run  |

### Examples

```json
get_exceptions({"match_run_id": "run_01HXY...", "side": "a", "page": 0, "page_size": 50})
→ {"ok": true, "data": {
     "match_run_id": "run_01HXY...",
     "side": "a",
     "page": 0,
     "page_size": 50,
     "exceptions": [...30 rows...],
     "total": 30
   }}

// Page beyond end returns an empty array — total stays the same
get_exceptions({"match_run_id": "run_01HXY...", "side": "a", "page": 5})
→ {"ok": true, "data": {"exceptions": [], "total": 30, ...}}
```

---

## Cross-cutting

- All tools accept `description` and emit it on progress events where supported (see [09-architecture.md](./09-architecture.md#progress-events)).
- All tools execute in the workspace bound to the harness's `cwd` — no tool exposes the workspace hash; the shim handles it.
- Row caps and string truncation are server-side guardrails to keep tool-result payloads small enough for the harness's context window.

> TODO: progress events are emitted by the daemon over SSE but the MCP shim does not currently bridge them into MCP `notifications/progress`. Tracked in the shim source (`src/mcp/server.ts`).
