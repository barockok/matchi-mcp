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
import { getExceptions } from './get-exceptions'
import type { ToolContext } from './types'

describe('get_exceptions', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext
  let runId: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-getex-'))
    process.env.MATCHI_HOME = home
    reg = new WorkspaceRegistry({ idleTimeoutMs: 60_000 })
    const ws = await reg.touch('test00000001')
    const recon = new ReconStore(ws.meta); await recon.init()
    const recipe = new RecipeStore(ws.meta); await recipe.init()
    const errorMemory = new ErrorMemoryStore(ws.meta); await errorMemory.init()
    ctx = { ws, recon, recipe, errorMemory, bus: new ProgressBus() }

    const aPath = join(home, 'a.csv')
    const bPath = join(home, 'b.csv')
    writeFileSync(aPath, 'id,amount\n1,100\n2,200\n4,400\n')
    writeFileSync(bPath, 'id,amount\n1,100\n2,200\n5,500\n')
    const upA = await uploadDataset.run({ path: aPath, alias: 'a' }, ctx)
    const upB = await uploadDataset.run({ path: bPath, alias: 'b' }, ctx)
    if (!upA.ok || !upB.ok) throw new Error('upload failed')
    const m = await runMatch.run(
      {
        a: upA.data.table_name,
        b: upB.data.table_name,
        matched_sql: `SELECT a.id, a.amount FROM "${upA.data.table_name}" a JOIN "${upB.data.table_name}" b ON a.id = b.id`
      },
      ctx
    )
    if (!m.ok) throw new Error('match failed')
    runId = m.data.matchRunId
  })

  afterEach(async () => {
    await reg.closeAll()
    rmSync(home, { recursive: true, force: true })
  })

  it('paginates side A exceptions', async () => {
    const res = await getExceptions.run({ match_run_id: runId, side: 'a', page: 0, page_size: 50 }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.exceptions.length).toBe(1)
    expect(res.data.total).toBe(1)
  })

  it('paginates all exceptions', async () => {
    const res = await getExceptions.run({ match_run_id: runId, side: 'all', page: 0, page_size: 50 }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.exceptions.length).toBe(2)
    expect(res.data.total).toBe(2)
  })

  it('returns not_found for missing run', async () => {
    const res = await getExceptions.run({ match_run_id: 'no-run', side: 'all', page: 0, page_size: 50 }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('not_found')
  })
})
