import { z } from 'zod'
import { existsSync } from 'node:fs'
import { extname, basename } from 'node:path'
import { workspaceHash } from '../../shared/hash'
import type { Tool } from './types'

export const uploadDatasetSchema = z.object({
  path: z.string(),
  alias: z.string().optional(),
  description: z.string().optional()
})

export type UploadDatasetArgs = z.infer<typeof uploadDatasetSchema>

export interface UploadDatasetData {
  table_name: string
  rows: number
  columns: { name: string; type: string }[]
}

export const uploadDataset: Tool<UploadDatasetArgs, UploadDatasetData> = {
  name: 'upload_dataset',
  schema: uploadDatasetSchema,
  async run({ path, alias }, ctx) {
    if (!existsSync(path)) {
      return { ok: false, error: { code: 'not_found', message: `file ${path} does not exist` } }
    }
    const ext = extname(path).toLowerCase()
    if (ext !== '.csv' && ext !== '.xlsx') {
      return {
        ok: false,
        error: { code: 'unsupported_format', message: `expected .csv or .xlsx, got ${ext}` }
      }
    }
    const baseName = (alias ?? basename(path, ext)).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    const table = `${ext === '.csv' ? 'csv' : 'xlsx'}_${baseName}_${workspaceHash(path).slice(0, 8)}`
    const escaped = path.replace(/'/g, "''")

    try {
      if (ext === '.csv') {
        await ctx.ws.data.execute(
          `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv_auto('${escaped}')`
        )
      } else {
        await ctx.ws.data.execute(`INSTALL excel; LOAD excel;`)
        await ctx.ws.data.execute(
          `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_xlsx('${escaped}')`
        )
      }
    } catch (e) {
      return {
        ok: false,
        error: { code: 'ingestion_failed', message: e instanceof Error ? e.message : String(e) }
      }
    }

    const countRows = (await ctx.ws.data.query(`SELECT COUNT(*)::INT AS n FROM ${table}`)) as { n: number }[]
    const cols = (await ctx.ws.data.query(`DESCRIBE ${table}`)) as {
      column_name: string
      column_type: string
    }[]

    await ctx.ws.meta.execute(
      `CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, alias TEXT, uploaded_at BIGINT)`
    )
    const aliasLiteral = alias ? `'${alias.replace(/'/g, "''")}'` : 'NULL'
    await ctx.ws.meta.execute(
      `INSERT OR REPLACE INTO sources VALUES ('${table}', ${aliasLiteral}, ${Date.now()})`
    )

    return {
      ok: true,
      data: {
        table_name: table,
        rows: Number(countRows[0]?.n ?? 0),
        columns: cols.map(c => ({ name: c.column_name, type: c.column_type }))
      }
    }
  }
}
