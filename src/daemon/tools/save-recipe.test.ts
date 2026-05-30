import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { saveRecipe } from './save-recipe'
import type { ToolContext } from './types'

describe('save_recipe', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-saverecipe-'))
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

  it('saves a recipe', async () => {
    const res = await saveRecipe.run({
      name: 'bank-vs-gl',
      match_sql: 'SELECT 1',
      sources: [{ alias: 'bank', table: 'bank' }, { alias: 'gl', table: 'gl' }]
    }, ctx)
    expect(res.ok).toBe(true)
  })

  it('rejects duplicate without overwrite', async () => {
    const args = {
      name: 'r1',
      match_sql: 'SELECT 1',
      sources: [{ alias: 'a', table: 'a' }, { alias: 'b', table: 'b' }]
    }
    await saveRecipe.run(args, ctx)
    const res = await saveRecipe.run(args, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('recipe_exists')
  })

  it('overwrites when overwrite:true', async () => {
    await saveRecipe.run({
      name: 'r2',
      match_sql: 'SELECT 1',
      sources: [{ alias: 'a', table: 'a' }, { alias: 'b', table: 'b' }]
    }, ctx)
    const res = await saveRecipe.run({
      name: 'r2',
      match_sql: 'SELECT 2',
      sources: [{ alias: 'a', table: 'a' }, { alias: 'b', table: 'b' }],
      overwrite: true
    }, ctx)
    expect(res.ok).toBe(true)
    const got = await ctx.recipe.getRecipe('r2')
    expect(got?.match_sql).toBe('SELECT 2')
  })
})
