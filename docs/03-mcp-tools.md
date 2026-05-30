# MCP Tool Reference

Matchi exposes eight tools via the MCP server. All tools accept an optional `description` string. All return either `{ok: true, data: {...}}` or `{ok: false, error: {code, message, hint?}}`.

The schemas below are the Zod schemas in `src/daemon/tools/*.ts`. The MCP-exposed JSON Schema is generated via `zod-to-json-schema`.

## Index

- [`recall_known_mistakes`](#recall_known_mistakes)
- [`upload_dataset`](#upload_dataset)
- [`list_sources`](#list_sources)
- [`run_sql`](#run_sql)
- [`run_match`](#run_match)
- [`save_recipe`](#save_recipe)
- [`list_recipes`](#list_recipes)
- [`apply_recipe`](#apply_recipe)

---

## `recall_known_mistakes`

Return the top-10 error patterns the agent has tripped on previously in this workspace. Call once at the start of every session.

### Args

```ts
{}
```

### Returns

```ts
{ ok: true, data: { patterns: Array<{
  tool_name: string
  error_category: 'syntax' | 'not_found' | 'validation' | 'other'
  count: number
  last_seen: number
  hint?: string
}> } }
```

---

## `upload_dataset`

Register a local CSV / XLSX / Parquet file as a DuckDB **view** by default (zero-copy `CREATE OR REPLACE VIEW … AS SELECT * FROM read_csv_auto(path)` etc). Pass `materialize: true` to snapshot it into an actual table. Pass `sheet` for a specific XLSX sheet.

### Args

```ts
{
  path: string,            // .csv | .xlsx | .parquet
  alias?: string,          // becomes the DuckDB table/view name (snake_cased)
  sheet?: string,          // .xlsx only
  materialize?: boolean,   // default: false for csv/parquet, true for xlsx
  description?: string
}
```

### Returns

```ts
{
  ok: true,
  data: {
    table_name: string,                              // the cleaned alias
    rows: number,
    columns: Array<{name: string, type: string}>,
    mode: 'view' | 'table'
  }
}
```

### Errors

| code                 | when                                                              |
|----------------------|-------------------------------------------------------------------|
| `not_found`          | `path` does not exist on disk                                     |
| `unsupported_format` | extension is not `.csv` / `.xlsx` / `.parquet`                    |
| `sheet_unsupported`  | `sheet` was supplied for a non-xlsx file                          |
| `ingestion_failed`   | DuckDB `read_*` threw (message in payload)                        |

### Examples

```json
upload_dataset({"path": "./bank.csv", "alias": "bank"})
→ {"ok": true, "data": {"table_name": "bank", "rows": 247, "mode": "view", "columns": [...]}}

upload_dataset({"path": "./Q1.xlsx", "sheet": "Bank Jan", "alias": "bank_jan"})
→ {"ok": true, "data": {"table_name": "bank_jan", "rows": 247, "mode": "table", "columns": [...]}}
```

---

## `list_sources`

Enumerate datasets in the workspace. Derived from `information_schema.tables`.

### Args

```ts
{ description?: string }
```

### Returns

```ts
{ ok: true, data: { sources: Array<{
  table: string,
  rows: number,
  columns: Array<{name: string, type: string}>,
  is_view: boolean
}> } }
```

Tables whose names begin with `_` are treated as recon-internal and hidden.

---

## `run_sql`

Execute one read-only DuckDB query, or a batch of up to 10. Results are capped at 20 rows and 120 characters per string field. Dangerous keywords (`DROP`, `DELETE`, `INSERT`, `UPDATE`, `ALTER`, `CREATE`, `TRUNCATE`, `REPLACE`, `ATTACH`, `COPY`, `EXPORT`, `CALL`) are blocked.

### Args

Exactly one of `sql` or `queries` must be provided.

```ts
// Single
{ sql: string, limit?: number, count_only?: boolean, description?: string }

// Batch
{ queries: Array<{sql: string, limit?: number, count_only?: boolean, description?: string}>,
  description?: string }
```

### Returns

```ts
// Single
{ ok: true, data: { rows: Record<string, unknown>[], totalRows: number, truncated: boolean } }

// Single with count_only
{ ok: true, data: { totalRows: number } }

// Batch
{ ok: true, data: {
  results: Array<{ index, sql, description, status: 'success' | 'error', rows, totalRows, truncated, error }>,
  totalQueries: number, successCount: number, errorCount: number
} }
```

### Errors

| code                | when                                                        |
|---------------------|-------------------------------------------------------------|
| `dangerous_keyword` | SQL matches the blocked-keyword regex                       |
| `query_failed`      | parse or execution error                                    |
| `batch_too_large`   | `queries` empty or > 10                                     |

---

## `run_match`

Execute a reconciliation. Provide `matched_sql` joining two tables aliased as `a` and `b`; the tool materializes the matched relation, derives unmatched rows on each side via `NOT EXISTS` on shared columns, and returns inline previews (≤200 rows per side).

### Args

```ts
{
  matched_sql: string,    // SELECT joining a and b
  a: string,              // table A (must match /^[a-zA-Z0-9_]+$/)
  b: string,
  description?: string
}
```

### Returns

```ts
{
  ok: true,
  data: {
    matched: number,
    unmatched_a_total: number,
    unmatched_b_total: number,
    unmatched_a_preview: Record<string, unknown>[],   // ≤ 200
    unmatched_b_preview: Record<string, unknown>[],   // ≤ 200
    match_run_id: string
  }
}
```

Full unmatched sets are also exported as CSV inside the workspace's `exports/<run_id>/` dir for offline review.

### Errors

| code                 | when                                                            |
|----------------------|-----------------------------------------------------------------|
| `invalid_identifier` | `a` or `b` contains non-identifier characters                   |
| `not_found`          | `a` or `b` table does not exist                                 |
| `match_sql_failed`   | the `matched_sql` failed to execute                             |

---

## `save_recipe`

Persist a reusable recipe under `name`. The recipe stores the `match_sql` and the two `(alias, table)` mappings, so next month a fresh workspace can `apply_recipe(name)` after the same two aliases are uploaded.

### Args

```ts
{
  name: string,
  match_sql: string,
  sources: [{alias: string, table: string}, {alias: string, table: string}],   // exactly 2
  description?: string,
  overwrite?: boolean
}
```

### Returns

```ts
{ ok: true, data: { name: string } }
```

### Errors

| code             | when                                                              |
|------------------|-------------------------------------------------------------------|
| `recipe_exists`  | name already taken and `overwrite` is not `true`                  |

---

## `list_recipes`

List all saved recipes in this workspace.

### Returns

```ts
{ ok: true, data: { recipes: Array<{
  name: string,
  description: string | null,
  source_aliases: string[],
  match_sql: string,
  created_at: string,
  last_run_at: string | null,
  last_match_rate: number | null,
  run_count: number
}> } }
```

---

## `apply_recipe`

Re-run a saved recipe. Resolves each source alias against the current workspace via `list_sources`. If any source's `table` is missing, returns `sources_missing` with the list of missing aliases — the agent should `upload_dataset` them and retry.

### Args

```ts
{ name: string, description?: string }
```

### Returns

Same shape as `run_match`.

### Errors

| code                 | when                                                  |
|----------------------|-------------------------------------------------------|
| `recipe_not_found`   | no recipe with that name                              |
| `sources_missing`    | one or more source aliases not in current workspace   |

`sources_missing` payload includes `message` listing the missing aliases and a `hint` to upload them first.
