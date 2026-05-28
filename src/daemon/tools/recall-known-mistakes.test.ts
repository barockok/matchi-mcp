import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { ProgressBus } from '../progress'
import { recallKnownMistakes } from './recall-known-mistakes'
import type { ToolContext } from './types'

describe('recall_known_mistakes', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-recall-'))
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

  it('returns empty patterns by default', async () => {
    const res = await recallKnownMistakes.run({}, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.patterns).toEqual([])
  })

  it('returns recorded errors', async () => {
    await ctx.errorMemory.recordError('run_sql', 'SQL syntax error: foo', 'SELECT bad')
    const res = await recallKnownMistakes.run({}, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.patterns.length).toBe(1)
    expect(res.data.patterns[0].tool_name).toBe('run_sql')
  })
})
