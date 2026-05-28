import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { ProgressBus } from '../progress'
import { runMatch } from './run-match'
import { uploadDataset } from './upload-dataset'
import type { ToolContext } from './types'

describe('run_match', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext
  let tableA: string
  let tableB: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-runmatch-'))
    process.env.MATCHI_HOME = home
    reg = new WorkspaceRegistry({ idleTimeoutMs: 60_000 })
    const ws = await reg.touch('test00000001')
    const recon = new ReconStore(ws.meta); await recon.init()
    const recipe = new RecipeStore(ws.meta); await recipe.init()
    const errorMemory = new ErrorMemoryStore(ws.meta); await errorMemory.init()
    ctx = { ws, recon, recipe, errorMemory, bus: new ProgressBus() }

    const aPath = join(home, 'a.csv')
    const bPath = join(home, 'b.csv')
    writeFileSync(aPath, 'id,amount\n1,100\n2,200\n3,300\n4,400\n')
    writeFileSync(bPath, 'id,amount\n1,100\n2,200\n3,300\n5,500\n')
    const upA = await uploadDataset.run({ path: aPath, alias: 'a' }, ctx)
    const upB = await uploadDataset.run({ path: bPath, alias: 'b' }, ctx)
    if (!upA.ok || !upB.ok) throw new Error('upload failed')
    tableA = upA.data.table_name
    tableB = upB.data.table_name
  })

  afterEach(async () => {
    await reg.closeAll()
    rmSync(home, { recursive: true, force: true })
  })

  it('matches on id and reports correct unmatched counts', async () => {
    const res = await runMatch.run(
      {
        a: tableA,
        b: tableB,
        matched_sql: `SELECT a.id, a.amount FROM "${tableA}" a JOIN "${tableB}" b ON a.id = b.id AND a.amount = b.amount`
      },
      ctx
    )
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.matched).toBe(3)
    expect(res.data.unmatchedA).toBe(1)
    expect(res.data.unmatchedB).toBe(1)
    expect(res.data.totalExceptions).toBe(2)
    expect(res.data.matchRunId).toBeTruthy()
  })

  it('returns not_found for missing dataset', async () => {
    const res = await runMatch.run(
      { a: 'no_such_table', b: tableB, matched_sql: 'SELECT 1' },
      ctx
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('not_found')
  })
})
