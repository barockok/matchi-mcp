import { z } from 'zod'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolContext } from './types'
import type { ToolResponse } from '../../shared/protocol'

export const runMatchSchema = z.object({
  matched_sql: z.string(),
  a: z.string(),
  b: z.string(),
  description: z.string().optional()
})

export type RunMatchArgs = z.infer<typeof runMatchSchema>

export interface RunMatchData {
  matched: number
  unmatched_a_total: number
  unmatched_b_total: number
  unmatched_a_preview: Record<string, unknown>[]
  unmatched_b_preview: Record<string, unknown>[]
  match_run_id: string
}

const MAX_STR_LEN = 100
const PREVIEW_CAP = 200

function truncateRowStrings(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === 'string' && val.length > MAX_STR_LEN) {
        out[key] = val.slice(0, MAX_STR_LEN) + '...'
      } else if (typeof val === 'bigint') {
        out[key] = Number(val)
      } else {
        out[key] = val
      }
    }
    return out
  })
}

function sanitizeIdentifier(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error(`Invalid identifier: ${name}`)
  return name
}

/**
 * Core run_match implementation, shared between the run_match tool and apply_recipe.
 */
export async function runMatchCore(
  args: RunMatchArgs,
  ctx: ToolContext
): Promise<ToolResponse<RunMatchData>> {
  const { matched_sql, a, b } = args

  let tableA: string
  let tableB: string
  try {
    tableA = sanitizeIdentifier(a)
    tableB = sanitizeIdentifier(b)
  } catch (e) {
    return {
      ok: false,
      error: { code: 'invalid_identifier', message: e instanceof Error ? e.message : String(e) }
    }
  }

  try {
    await ctx.ws.data.query(`SELECT 1 FROM "${tableA}" LIMIT 0`)
  } catch {
    return { ok: false, error: { code: 'not_found', message: `dataset ${tableA} does not exist; upload it first` } }
  }
  try {
    await ctx.ws.data.query(`SELECT 1 FROM "${tableB}" LIMIT 0`)
  } catch {
    return { ok: false, error: { code: 'not_found', message: `dataset ${tableB} does not exist; upload it first` } }
  }

  const matchedSql = matched_sql.trim().replace(/;+$/, '')

  const matchTempTable = `_match_temp_${Date.now()}`
  try {
    await ctx.ws.data.execute(`CREATE TABLE "${matchTempTable}" AS ${matchedSql}`)
  } catch (createErr) {
    const errMsg = createErr instanceof Error ? createErr.message : String(createErr)
    return {
      ok: false,
      error: { code: 'match_sql_failed', message: errMsg, hint: 'matched_sql must alias datasets as a and b' }
    }
  }

  const matchedCntRows = (await ctx.ws.data.query(`SELECT COUNT(*) as cnt FROM "${matchTempTable}"`)) as {
    cnt: number | bigint
  }[]
  const matchedCount = Number(matchedCntRows[0]?.cnt ?? 0)

  const matchCols = (await ctx.ws.data.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${matchTempTable}'`
  )) as { column_name: string }[]
  const matchColNames = new Set(matchCols.map(r => String(r.column_name)))

  const aColsResult = (await ctx.ws.data.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableA}'`
  )) as { column_name: string }[]
  const aJoinCols = aColsResult.map(r => String(r.column_name)).filter(c => matchColNames.has(c))

  const bColsResult = (await ctx.ws.data.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableB}'`
  )) as { column_name: string }[]
  const bJoinCols = bColsResult.map(r => String(r.column_name)).filter(c => matchColNames.has(c))

  try {
    await ctx.ws.data.execute(`DROP TABLE IF EXISTS "${matchTempTable}"`)
  } catch {
    /* ignore */
  }

  let unmatchedASql: string
  let unmatchedBSql: string

  if (aJoinCols.length > 0) {
    const aJoin = aJoinCols.map(c => `"${tableA}"."${c}" = _m."${c}"`).join(' AND ')
    unmatchedASql = `WITH _matched AS (${matchedSql}) SELECT * FROM "${tableA}" WHERE NOT EXISTS (SELECT 1 FROM _matched _m WHERE ${aJoin})`
  } else {
    unmatchedASql = `SELECT * FROM "${tableA}" WHERE FALSE`
  }
  if (bJoinCols.length > 0) {
    const bJoin = bJoinCols.map(c => `"${tableB}"."${c}" = _m."${c}"`).join(' AND ')
    unmatchedBSql = `WITH _matched AS (${matchedSql}) SELECT * FROM "${tableB}" WHERE NOT EXISTS (SELECT 1 FROM _matched _m WHERE ${bJoin})`
  } else {
    unmatchedBSql = `SELECT * FROM "${tableB}" WHERE FALSE`
  }

  const leftOnly = (await ctx.ws.data.query(`SELECT COUNT(*) as cnt FROM (${unmatchedASql}) _ua`)) as {
    cnt: number | bigint
  }[]
  const unmatchedACount = Number(leftOnly[0]?.cnt ?? 0)
  const rightOnly = (await ctx.ws.data.query(`SELECT COUNT(*) as cnt FROM (${unmatchedBSql}) _ub`)) as {
    cnt: number | bigint
  }[]
  const unmatchedBCount = Number(rightOnly[0]?.cnt ?? 0)

  const run = ctx.recon.addRun({
    name: `Match ${tableA} vs ${tableB}`,
    datasetIdA: tableA,
    datasetIdB: tableB,
    joinKey: 'custom_sql',
    config: { matched_sql: matchedSql }
  })

  const exportDir = join(ctx.ws.dir, 'exports', run.id)
  mkdirSync(exportDir, { recursive: true })
  const unmatchedAPath = join(exportDir, `unmatched_${tableA}.csv`)
  const unmatchedBPath = join(exportDir, `unmatched_${tableB}.csv`)

  if (unmatchedACount > 0) {
    await ctx.ws.data.execute(
      `COPY (${unmatchedASql}) TO '${unmatchedAPath.replace(/'/g, "''")}' (HEADER, DELIMITER ',')`
    )
  }
  if (unmatchedBCount > 0) {
    await ctx.ws.data.execute(
      `COPY (${unmatchedBSql}) TO '${unmatchedBPath.replace(/'/g, "''")}' (HEADER, DELIMITER ',')`
    )
  }

  const previewA =
    unmatchedACount > 0
      ? truncateRowStrings(await ctx.ws.data.query(`${unmatchedASql} LIMIT ${PREVIEW_CAP}`))
      : []
  const previewB =
    unmatchedBCount > 0
      ? truncateRowStrings(await ctx.ws.data.query(`${unmatchedBSql} LIMIT ${PREVIEW_CAP}`))
      : []

  const updatedRun = ctx.recon.updateRun(run.id, {
    status: 'completed',
    summary: {
      totalA: matchedCount + unmatchedACount,
      totalB: matchedCount + unmatchedBCount,
      matched: matchedCount,
      unmatchedA: unmatchedACount,
      unmatchedB: unmatchedBCount,
      exceptions: unmatchedACount + unmatchedBCount
    }
  })

  await ctx.recon
    .persistRun(updatedRun, {
      datasets: [
        { role: 'primary', id: tableA, name: tableA, row_count: matchedCount + unmatchedACount },
        { role: 'secondary', id: tableB, name: tableB, row_count: matchedCount + unmatchedBCount }
      ],
      unmatchedFiles: [
        ...(unmatchedACount > 0 ? [{ dataset_id: tableA, path: unmatchedAPath, count: unmatchedACount }] : []),
        ...(unmatchedBCount > 0 ? [{ dataset_id: tableB, path: unmatchedBPath, count: unmatchedBCount }] : [])
      ],
      matchedSql,
      trigger: 'chat'
    })
    .catch(err => console.error('Failed to persist run:', err))

  // Only the preview is retained on the in-memory result — no pagination tool anymore.
  ctx.recon.setMatchResult(run.id, {
    runId: run.id,
    matchedPairs: [],
    exceptionsA: previewA,
    exceptionsB: previewB,
    exportDir,
    unmatchedAPath: unmatchedACount > 0 ? unmatchedAPath : undefined,
    unmatchedBPath: unmatchedBCount > 0 ? unmatchedBPath : undefined
  })

  return {
    ok: true,
    data: {
      matched: matchedCount,
      unmatched_a_total: unmatchedACount,
      unmatched_b_total: unmatchedBCount,
      unmatched_a_preview: previewA,
      unmatched_b_preview: previewB,
      match_run_id: run.id
    }
  }
}

export const runMatch: Tool<RunMatchArgs, RunMatchData> = {
  name: 'run_match',
  schema: runMatchSchema,
  run: runMatchCore
}
