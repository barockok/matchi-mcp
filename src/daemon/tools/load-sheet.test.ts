import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { ProgressBus } from '../progress'
import { loadSheet } from './load-sheet'
import type { ToolContext } from './types'

describe('load_sheet', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-loadsheet-'))
    process.env.MATCHI_HOME = home
    reg = new WorkspaceRegistry({ idleTimeoutMs: 60_000 })
    const ws = await reg.touch('test00000001')
    const recon = new ReconStore(ws.meta); await recon.init()
    const recipe = new RecipeStore(ws.meta); await recipe.init()
    const errorMemory = new ErrorMemoryStore(ws.meta); await errorMemory.init()
    ctx = { ws, recon, recipe, errorMemory, bus: new ProgressBus() }
  })

  afterEach(async () => {
    await reg.closeAll()
    rmSync(home, { recursive: true, force: true })
  })

  it('returns not_found for missing file', async () => {
    const res = await loadSheet.run({ path: '/no/such.xlsx', sheet: 'Sheet1' }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('not_found')
  })

  it('rejects non-xlsx extensions', async () => {
    const csv = join(home, 'foo.csv')
    writeFileSync(csv, 'a,b\n')
    const res = await loadSheet.run({ path: csv, sheet: 'Sheet1' }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('unsupported_format')
  })

  it.todo('happy path with xlsx fixture (needs binary xlsx fixture)')
})
