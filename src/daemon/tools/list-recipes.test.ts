import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { listRecipes } from './list-recipes'
import { saveRecipe } from './save-recipe'
import type { ToolContext } from './types'

describe('list_recipes', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-listrecipes-'))
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

  it('returns empty for fresh workspace', async () => {
    const res = await listRecipes.run({}, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.recipes).toEqual([])
  })

  it('lists saved recipes with source_aliases', async () => {
    await saveRecipe.run({
      name: 'r1',
      match_sql: 'SELECT 1',
      sources: [{ alias: 'bank', table: 'bank' }, { alias: 'gl', table: 'gl' }],
      description: 'monthly'
    }, ctx)
    const res = await listRecipes.run({}, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.recipes).toHaveLength(1)
    expect(res.data.recipes[0].name).toBe('r1')
    expect(res.data.recipes[0].source_aliases).toEqual(['bank', 'gl'])
    expect(res.data.recipes[0].description).toBe('monthly')
  })
})
