import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { uploadDataset } from './upload-dataset'
import { saveRecipe } from './save-recipe'
import { applyRecipe } from './apply-recipe'
import type { ToolContext } from './types'

describe('apply_recipe', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-applyrecipe-'))
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

  it('returns recipe_not_found when missing', async () => {
    const res = await applyRecipe.run({ name: 'nope' }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('recipe_not_found')
  })

  it('returns sources_missing when workspace lacks the recipe sources', async () => {
    await saveRecipe.run({
      name: 'r',
      match_sql: 'SELECT a.id FROM a JOIN b USING (id)',
      sources: [{ alias: 'a', table: 'a' }, { alias: 'b', table: 'b' }]
    }, ctx)
    const res = await applyRecipe.run({ name: 'r' }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('sources_missing')
  })

  it('round-trips: save then reset then apply re-runs the match', async () => {
    const aPath = join(home, 'a.csv')
    const bPath = join(home, 'b.csv')
    writeFileSync(aPath, 'id,amount\n1,100\n2,200\n3,300\n')
    writeFileSync(bPath, 'id,amount\n1,100\n2,200\n4,400\n')
    await uploadDataset.run({ path: aPath, alias: 'a' }, ctx)
    await uploadDataset.run({ path: bPath, alias: 'b' }, ctx)

    const matchSql = `SELECT a.id, a.amount FROM a a JOIN b b ON a.id = b.id AND a.amount = b.amount`
    await saveRecipe.run({
      name: 'simple',
      match_sql: matchSql,
      sources: [{ alias: 'a', table: 'a' }, { alias: 'b', table: 'b' }]
    }, ctx)

    // Reset by dropping the views.
    await ctx.ws.data.execute(`DROP VIEW IF EXISTS a`)
    await ctx.ws.data.execute(`DROP VIEW IF EXISTS b`)

    // Re-upload (simulating next-month workflow).
    await uploadDataset.run({ path: aPath, alias: 'a' }, ctx)
    await uploadDataset.run({ path: bPath, alias: 'b' }, ctx)

    const res = await applyRecipe.run({ name: 'simple' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.matched).toBe(2)
    expect(res.data.unmatched_a_total).toBe(1)
    expect(res.data.unmatched_b_total).toBe(1)

    const updated = await ctx.recipe.getRecipe('simple')
    expect(updated?.run_count).toBe(1)
  })
})
