import { zodToJsonSchema } from 'zod-to-json-schema'
import { TOOLS } from '../daemon/tools'

const DESCRIPTIONS: Record<string, string> = {
  upload_dataset:
    'Register a local CSV/XLSX/Parquet file as a DuckDB view (zero-copy) or materialized table. Optional `sheet` for .xlsx; optional `materialize:true` for a snapshot table.',
  list_sources:
    'List all datasets in the workspace (tables and views). Each entry includes row count, column types, and an `is_view` flag.',
  run_sql:
    'Execute a read-only DuckDB SQL query (or up to 10 batched queries). Caps results at 20 rows; DROP/DELETE/INSERT/UPDATE/ALTER/CREATE/TRUNCATE/REPLACE/ATTACH/COPY/EXPORT/CALL are blocked.',
  run_match:
    'Run a reconciliation: provide matched_sql that joins datasets aliased as a and b. Returns matched count, unmatched totals, and an inline preview of up to 200 unmatched rows per side.',
  recall_known_mistakes:
    'Return the top-10 patterns the agent has previously tripped over in this workspace. Call once at session start.',
  save_recipe:
    'Persist a reusable recipe (match_sql + source aliases) under a name. Use at the end of a successful recon so next month you can call apply_recipe instead of re-deriving.',
  list_recipes:
    'List saved recipes in this workspace. Each entry includes name, description, source aliases, match_sql, and last-run stats.',
  apply_recipe:
    "Re-run a saved recipe. Returns the same shape as run_match. Fails with code 'sources_missing' if any source alias is not in the current workspace."
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

function jsonSchemaFor(schema: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = zodToJsonSchema(schema as any, { target: 'jsonSchema7' }) as Record<string, unknown>
  if ('$schema' in out) delete (out as Record<string, unknown>).$schema
  return out
}

export function listMcpTools(): McpToolDefinition[] {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: DESCRIPTIONS[name] ?? `Matchi tool: ${name}`,
    inputSchema: jsonSchemaFor(tool.schema)
  }))
}
