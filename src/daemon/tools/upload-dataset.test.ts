import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { uploadDataset } from './upload-dataset'
import { listSources } from './list-sources'
import type { ToolContext } from './types'

describe('upload_dataset', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext
  let csvPath: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-upload-'))
    process.env.MATCHI_HOME = home
    reg = new WorkspaceRegistry({ idleTimeoutMs: 60_000 })
    const ws = await reg.touch('test00000001')
    const recon = new ReconStore(ws.meta); await recon.init()
    const recipe = new RecipeStore(ws.meta); await recipe.init()
    const errorMemory = new ErrorMemoryStore(ws.meta); await errorMemory.init()
    ctx = { ws, recon, recipe, errorMemory }
    csvPath = join(home, 'sample.csv')
    writeFileSync(csvPath, 'id,name\n1,a\n2,b\n3,c\n4,d\n5,e\n')
  })

  afterEach(async () => {
    await reg.closeAll()
    rmSync(home, { recursive: true, force: true })
  })

  it('uploads a CSV with 5 rows as a zero-copy VIEW by default', async () => {
    const res = await uploadDataset.run({ path: csvPath }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.rows).toBe(5)
    expect(res.data.table_name).toBe('sample')
    expect(res.data.mode).toBe('view')

    const listed = await listSources.run({}, ctx)
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.data.sources).toHaveLength(1)
    expect(listed.data.sources[0].rows).toBe(5)
    expect(listed.data.sources[0].is_view).toBe(true)
  })

  it('materializes when materialize:true', async () => {
    const res = await uploadDataset.run({ path: csvPath, alias: 'snap', materialize: true }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.mode).toBe('table')
    const listed = await listSources.run({}, ctx)
    if (!listed.ok) throw new Error('unreachable')
    const snap = listed.data.sources.find(s => s.table === 'snap')
    expect(snap?.is_view).toBe(false)
  })

  it('returns not_found for missing file', async () => {
    const res = await uploadDataset.run({ path: '/no/such/file.csv' }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('not_found')
  })

  it('returns unsupported_format for non-csv/xlsx', async () => {
    const txt = join(home, 'foo.txt')
    writeFileSync(txt, 'hello')
    const res = await uploadDataset.run({ path: txt }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('unsupported_format')
  })
})
