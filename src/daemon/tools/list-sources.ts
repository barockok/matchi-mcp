import { z } from 'zod'
import type { Tool } from './types'

export const listSourcesSchema = z.object({
  description: z.string().optional()
})

export type ListSourcesArgs = z.infer<typeof listSourcesSchema>

export interface SourceInfo {
  table: string
  rows: number
  columns: { name: string; type: string }[]
  is_view: boolean
}

interface SourceRow {
  table_name: string
  table_type: string
}

export const listSources: Tool<ListSourcesArgs, { sources: SourceInfo[] }> = {
  name: 'list_sources',
  schema: listSourcesSchema,
  async run(_args, ctx) {
    const rows = (await ctx.ws.data.query(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = 'main'
       ORDER BY table_name`
    )) as unknown as SourceRow[]

    const out: SourceInfo[] = []
    for (const r of rows) {
      // Skip recon-internal scratch tables.
      if (r.table_name.startsWith('_')) continue
      try {
        const countRows = (await ctx.ws.data.query(
          `SELECT COUNT(*)::INT AS n FROM ${r.table_name}`
        )) as { n: number }[]
        const cols = (await ctx.ws.data.query(`DESCRIBE ${r.table_name}`)) as {
          column_name: string
          column_type: string
        }[]
        out.push({
          table: r.table_name,
          rows: Number(countRows[0]?.n ?? 0),
          columns: cols.map(c => ({ name: c.column_name, type: c.column_type })),
          is_view: r.table_type === 'VIEW'
        })
      } catch {
        // Table dropped concurrently — skip.
      }
    }

    return { ok: true, data: { sources: out } }
  }
}
