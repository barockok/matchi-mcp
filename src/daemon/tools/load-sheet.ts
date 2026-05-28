import { z } from 'zod'
import { existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { workspaceHash } from '../../shared/hash'
import type { Tool } from './types'

export const loadSheetSchema = z.object({
  path: z.string(),
  sheet: z.string(),
  alias: z.string().optional(),
  description: z.string().optional()
})

export type LoadSheetArgs = z.infer<typeof loadSheetSchema>

export interface LoadSheetData {
  table_name: string
  rows: number
  columns: { name: string; type: string }[]
}

export const loadSheet: Tool<LoadSheetArgs, LoadSheetData> = {
  name: 'load_sheet',
  schema: loadSheetSchema,
  async run({ path, sheet, alias }, ctx) {
    if (!existsSync(path)) {
      return { ok: false, error: { code: 'not_found', message: `file ${path} does not exist` } }
    }
    const ext = extname(path).toLowerCase()
    if (ext !== '.xlsx') {
      return { ok: false, error: { code: 'unsupported_format', message: `expected .xlsx, got ${ext}` } }
    }
    const baseName = (alias ?? `${basename(path, ext)}_${sheet}`).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    const table = `xlsx_${baseName}_${workspaceHash(path + ':' + sheet).slice(0, 8)}`
    const escapedPath = path.replace(/'/g, "''")
    const escapedSheet = sheet.replace(/'/g, "''")

    try {
      await ctx.ws.data.execute(`INSTALL excel; LOAD excel;`)
      await ctx.ws.data.execute(
        `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_xlsx('${escapedPath}', sheet='${escapedSheet}')`
      )
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
