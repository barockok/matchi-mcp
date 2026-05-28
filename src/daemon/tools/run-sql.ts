import { z } from 'zod'
import type { Tool, ToolContext } from './types'
import type { ToolResponse } from '../../shared/protocol'

const MAX_ROWS = 20
const MAX_STRING_LENGTH = 120
const MAX_BATCH_SIZE = 10
const MAX_BATCH_PAYLOAD = 20_000

const DANGEROUS_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|COPY|EXPORT|CALL)\b/i

const batchItemSchema = z.object({
  sql: z.string(),
  limit: z.number().optional(),
  count_only: z.boolean().optional(),
  description: z.string().optional()
})

export const runSqlSchema = z
  .object({
    sql: z.string().optional(),
    limit: z.number().optional(),
    count_only: z.boolean().optional(),
    queries: z.array(batchItemSchema).max(MAX_BATCH_SIZE).optional(),
    description: z.string().optional()
  })
  .refine(v => (typeof v.sql === 'string') !== Array.isArray(v.queries), {
    message: 'provide exactly one of sql|queries'
  })

export type RunSqlArgs = z.infer<typeof runSqlSchema>

interface BatchQueryResult {
  index: number
  sql: string
  description: string | null
  status: 'success' | 'error'
  rows: Record<string, unknown>[]
  totalRows: number
  truncated: boolean
  error: string | null
}

interface SingleResult {
  rows: Record<string, unknown>[]
  totalRows: number
  truncated: boolean
}

interface BatchResultPayload {
  results: BatchQueryResult[]
  totalQueries: number
  successCount: number
  errorCount: number
}

function truncateStrings(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === 'string' && val.length > MAX_STRING_LENGTH) {
        out[key] = val.slice(0, MAX_STRING_LENGTH) + '...'
      } else if (typeof val === 'bigint') {
        out[key] = Number(val)
      } else {
        out[key] = val
      }
    }
    return out
  })
}

async function executeSingleQuery(
  ctx: ToolContext,
  sql: string,
  limit: number,
  countOnly: boolean
): Promise<{ ok: true; result: SingleResult } | { ok: false; code: string; message: string }> {
  const cleaned = sql.trim().replace(/;+$/, '')

  if (DANGEROUS_KEYWORDS.test(cleaned)) {
    return {
      ok: false,
      code: 'dangerous_keyword',
      message:
        'Query contains disallowed keywords (DROP, DELETE, INSERT, UPDATE, ALTER, CREATE, TRUNCATE, REPLACE, ATTACH, COPY, EXPORT, CALL)'
    }
  }

  try {
    await ctx.ws.data.query(`EXPLAIN ${cleaned}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      code: 'query_failed',
      message: `SQL syntax error: ${msg}. Fix the query and try again.`
    }
  }

  if (countOnly) {
    const result = await ctx.ws.data.query(`SELECT COUNT(*) as total FROM (${cleaned}) _counted`)
    return { ok: true, result: { rows: [], totalRows: Number(result[0]?.total ?? 0), truncated: false } }
  }

  const cappedLimit = Math.min(Math.max(limit, 1), MAX_ROWS)
  const queryToRun = `SELECT * FROM (${cleaned}) _q LIMIT ${cappedLimit}`
  const countResult = await ctx.ws.data.query(`SELECT COUNT(*) as total FROM (${cleaned}) _counted`)
  const totalRows = Number(countResult[0]?.total ?? 0)
  let rows: Record<string, unknown>[]
  try {
    rows = await ctx.ws.data.query(queryToRun)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, code: 'query_failed', message: msg }
  }

  return {
    ok: true,
    result: {
      rows: truncateStrings(rows),
      totalRows,
      truncated: totalRows > rows.length
    }
  }
}

type RunSqlData = SingleResult | { totalRows: number } | BatchResultPayload

export const runSql: Tool<RunSqlArgs, RunSqlData> = {
  name: 'run_sql',
  schema: runSqlSchema as unknown as z.ZodType<RunSqlArgs>,
  async run(args, ctx): Promise<ToolResponse<RunSqlData>> {
    // Batch mode
    if (Array.isArray(args.queries)) {
      const queries = args.queries
      if (queries.length === 0) {
        return { ok: false, error: { code: 'batch_too_large', message: 'queries array must contain at least 1 query' } }
      }
      if (queries.length > MAX_BATCH_SIZE) {
        return {
          ok: false,
          error: { code: 'batch_too_large', message: `queries array exceeds maximum batch size of ${MAX_BATCH_SIZE}` }
        }
      }

      const results: BatchQueryResult[] = []
      let cumulativePayloadSize = 0

      for (let i = 0; i < queries.length; i++) {
        const q = queries[i]
        const limit = q.limit != null ? Math.min(Math.max(Number(q.limit), 1), MAX_ROWS) : MAX_ROWS
        const countOnly = Boolean(q.count_only)
        const desc = q.description && q.description.length > 200 ? q.description.slice(0, 200) : q.description || null

        if (ctx.jobId) {
          ctx.bus.emitProgress(ctx.jobId, 'query', {
            index: i + 1,
            total: queries.length,
            description: desc
          })
        }

        const queryResult = await executeSingleQuery(ctx, q.sql, limit, countOnly)
        const batchResult: BatchQueryResult = queryResult.ok
          ? {
              index: i,
              sql: q.sql,
              description: desc,
              status: 'success',
              rows: queryResult.result.rows,
              totalRows: queryResult.result.totalRows,
              truncated: queryResult.result.truncated,
              error: null
            }
          : {
              index: i,
              sql: q.sql,
              description: desc,
              status: 'error',
              rows: [],
              totalRows: 0,
              truncated: false,
              error: queryResult.message
            }

        const resultJson = JSON.stringify(batchResult)
        if (cumulativePayloadSize + resultJson.length > MAX_BATCH_PAYLOAD && batchResult.rows.length > 0) {
          const available = MAX_BATCH_PAYLOAD - cumulativePayloadSize
          while (batchResult.rows.length > 1) {
            batchResult.rows.pop()
            batchResult.truncated = true
            if (JSON.stringify(batchResult).length <= available) break
          }
        }
        cumulativePayloadSize += JSON.stringify(batchResult).length
        results.push(batchResult)
      }

      return {
        ok: true,
        data: {
          results,
          totalQueries: queries.length,
          successCount: results.filter(r => r.status === 'success').length,
          errorCount: results.filter(r => r.status === 'error').length
        }
      }
    }

    // Single mode
    if (typeof args.sql !== 'string') {
      return { ok: false, error: { code: 'query_failed', message: 'Either sql (string) or queries (array) is required' } }
    }

    const countOnly = Boolean(args.count_only)
    const limit = Math.min(Math.max(Number(args.limit) || MAX_ROWS, 1), MAX_ROWS)
    const single = await executeSingleQuery(ctx, args.sql, limit, countOnly)
    if (!single.ok) {
      return { ok: false, error: { code: single.code, message: single.message } }
    }
    if (countOnly) {
      return { ok: true, data: { totalRows: single.result.totalRows } }
    }
    return { ok: true, data: single.result }
  }
}
