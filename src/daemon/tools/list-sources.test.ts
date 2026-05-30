import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { listSources } from './list-sources'
import { uploadDataset } from './upload-dataset'
import type { ToolContext } from './types'

describe('list_sources', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-list-'))
    process.env.MATCHI_HOME = home
    reg = new WorkspaceRegistry({ idleTimeoutMs: 60_000 })
    const ws = await reg.touch('test00000001')
    const recon = new ReconStore(ws.meta); await recon.init()
    const recipe = new RecipeStore(ws.meta); await recipe.init()
    const errorMemory = new ErrorMemoryStore(ws.meta); await errorMemory.init()
    ctx = { ws, recon, recipe, errorMemory }
  })

  afterEach(async () => {
    await reg.closeAll()
    rmSync(home, { recursive: true, force: true })
  })

  it('returns empty when nothing uploaded', async () => {
    const res = await listSources.run({}, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.sources).toEqual([])
  })

  it('reflects an uploaded CSV (as VIEW) with column metadata', async () => {
    const csvPath = join(home, 'data.csv')
    writeFileSync(csvPath, 'id,amount\n1,100\n2,200\n')
    const up = await uploadDataset.run({ path: csvPath, alias: 'data' }, ctx)
    expect(up.ok).toBe(true)
    const res = await listSources.run({}, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.sources).toHaveLength(1)
    expect(res.data.sources[0].table).toBe('data')
    expect(res.data.sources[0].rows).toBe(2)
    expect(res.data.sources[0].is_view).toBe(true)
    expect(res.data.sources[0].columns.map(c => c.name).sort()).toEqual(['amount', 'id'])
  })

  it('reflects a materialized table with is_view:false', async () => {
    const csvPath = join(home, 'snap.csv')
    writeFileSync(csvPath, 'id\n1\n2\n')
    await uploadDataset.run({ path: csvPath, alias: 'snap', materialize: true }, ctx)
    const res = await listSources.run({}, ctx)
    if (!res.ok) throw new Error('unreachable')
    const snap = res.data.sources.find(s => s.table === 'snap')
    expect(snap?.is_view).toBe(false)
  })
})
