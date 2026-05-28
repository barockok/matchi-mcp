import { z } from 'zod'
import type { Tool } from './types'

export const listSourcesSchema = z.object({
  description: z.string().optional()
})

export type ListSourcesArgs = z.infer<typeof listSourcesSchema>

export interface SourceInfo {
  table: string
  alias: string | null
  rows: number
  columns: { name: string; type: string }[]
  uploaded_at: number | null
}

async function ensureSourcesTable(ctx: { ws: { meta: { execute: (sql: string) => Promise<void> } } }): Promise<void> {
  await ctx.ws.meta.execute(
    `CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, alias TEXT, uploaded_at BIGINT)`
  )
}

export const listSources: Tool<ListSourcesArgs, { sources: SourceInfo[] }> = {
  name: 'list_sources',
  schema: listSourcesSchema,
  async run(_args, ctx) {
    await ensureSourcesTable(ctx)
    const registered = (await ctx.ws.meta.query(
      `SELECT name, alias, uploaded_at FROM sources ORDER BY uploaded_at DESC`
    )) as { name: string; alias: string | null; uploaded_at: number | bigint | null }[]

    const sources: SourceInfo[] = []
    for (const row of registered) {
      const table = row.name
      try {
        const cols = (await ctx.ws.data.query(`DESCRIBE ${table}`)) as {
          column_name: string
          column_type: string
        }[]
        const countRows = (await ctx.ws.data.query(
          `SELECT COUNT(*)::INT AS n FROM ${table}`
        )) as { n: number }[]
        sources.push({
          table,
          alias: row.alias ?? null,
          rows: Number(countRows[0]?.n ?? 0),
          columns: cols.map(c => ({ name: c.column_name, type: c.column_type })),
          uploaded_at:
            row.uploaded_at == null ? null : typeof row.uploaded_at === 'bigint' ? Number(row.uploaded_at) : row.uploaded_at
        })
      } catch {
        // Table missing — skip (stale registry entry)
      }
    }

    return { ok: true, data: { sources } }
  }
}
