import { zodToJsonSchema } from 'zod-to-json-schema'
import { TOOLS } from '../daemon/tools'

const DESCRIPTIONS: Record<string, string> = {
  upload_dataset:
    'Load a local CSV or XLSX file into the workspace DuckDB. Returns the table name, row count, and column list.',
  list_sources: 'List all datasets registered in the current workspace.',
  load_sheet: 'Load a specific sheet from an XLSX file into the workspace DuckDB.',
  run_sql:
    'Execute a read-only DuckDB SQL query (or up to 10 batched queries). Caps results at 20 rows; DROP/DELETE/INSERT/UPDATE/ALTER/CREATE/TRUNCATE/REPLACE/ATTACH/COPY/EXPORT/CALL are blocked.',
  run_match:
    'Run a reconciliation: provide matched_sql that joins datasets aliased as a and b. Streams progress and persists matched + unmatched results.',
  get_exceptions: 'Page through unmatched rows from the most recent run_match for one side.',
  recall_known_mistakes:
    'Return the top-10 patterns the agent has previously tripped over in this workspace. Call once at session start.'
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

function jsonSchemaFor(schema: unknown): Record<string, unknown> {
  // zodToJsonSchema returns either the schema directly or a wrapped { definitions, $ref }
  // depending on options. We use the default which inlines into a root object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = zodToJsonSchema(schema as any, { target: 'jsonSchema7' }) as Record<string, unknown>
  // Drop the top-level $schema key — MCP clients don't need it
  // and some validators don't accept it inside tool inputSchema.
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
