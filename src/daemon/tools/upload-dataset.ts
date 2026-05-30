import { z } from 'zod'
import { existsSync } from 'node:fs'
import { extname, basename } from 'node:path'
import type { Tool } from './types'

const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.parquet'])

export const uploadDatasetSchema = z.object({
  path: z.string(),
  alias: z.string().optional(),
  sheet: z.string().optional(),
  materialize: z.boolean().optional(),
  description: z.string().optional()
})

export type UploadDatasetArgs = z.infer<typeof uploadDatasetSchema>

export interface UploadDatasetData {
  table_name: string
  rows: number
  columns: { name: string; type: string }[]
  mode: 'view' | 'table'
}

export const uploadDataset: Tool<UploadDatasetArgs, UploadDatasetData> = {
  name: 'upload_dataset',
  schema: uploadDatasetSchema,
  async run({ path, alias, sheet, materialize }, ctx) {
    if (!existsSync(path)) {
      return { ok: false, error: { code: 'not_found', message: `file ${path} does not exist` } }
    }
    const ext = extname(path).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      return {
        ok: false,
        error: { code: 'unsupported_format', message: `expected .csv/.xlsx/.parquet, got ${ext}` }
      }
    }
    if (sheet && ext !== '.xlsx') {
      return { ok: false, error: { code: 'sheet_unsupported', message: 'sheet arg only valid for .xlsx' } }
    }
    const baseName = (alias ?? basename(path, ext)).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    // XLSX is expensive to parse repeatedly — default to materialize unless caller says false.
    const shouldMaterialize = materialize ?? (ext === '.xlsx')
    const object = shouldMaterialize ? 'TABLE' : 'VIEW'
    const escapedPath = path.replace(/'/g, "''")
    const reader =
      ext === '.csv'
        ? `read_csv_auto('${escapedPath}')`
        : ext === '.parquet'
          ? `read_parquet('${escapedPath}')`
          : `read_xlsx('${escapedPath}'${sheet ? `, sheet='${sheet.replace(/'/g, "''")}'` : ''})`

    try {
      if (ext === '.xlsx') {
        await ctx.ws.data.execute(`INSTALL excel; LOAD excel;`)
      }
      await ctx.ws.data.execute(`CREATE OR REPLACE ${object} ${baseName} AS SELECT * FROM ${reader}`)
    } catch (e) {
      return {
        ok: false,
        error: { code: 'ingestion_failed', message: e instanceof Error ? e.message : String(e) }
      }
    }

    const countRows = (await ctx.ws.data.query(`SELECT COUNT(*)::INT AS n FROM ${baseName}`)) as { n: number }[]
    const cols = (await ctx.ws.data.query(`DESCRIBE ${baseName}`)) as {
      column_name: string
      column_type: string
    }[]

    return {
      ok: true,
      data: {
        table_name: baseName,
        rows: Number(countRows[0]?.n ?? 0),
        columns: cols.map(c => ({ name: c.column_name, type: c.column_type })),
        mode: object.toLowerCase() as 'view' | 'table'
      }
    }
  }
}
