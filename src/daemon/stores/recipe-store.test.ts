import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Engine } from '../db/engine'
import { RecipeStore } from './recipe-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('RecipeStore', () => {
  let dir: string
  let engine: Engine
  let store: RecipeStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'matchi-recipe-'))
    engine = new Engine(join(dir, 'meta.duckdb'))
    await engine.init()
    store = new RecipeStore(engine)
    await store.init()
  })
  afterEach(async () => {
    await engine.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('addRecipe + getRecipe round-trips name, match_sql, sources, description', async () => {
    const r = await store.addRecipe({
      name: 'bank-vs-gl',
      match_sql: 'SELECT 1',
      sources: [
        { alias: 'bank', table: 'bank_aug' },
        { alias: 'gl', table: 'gl_aug' }
      ],
      description: 'monthly recon'
    })
    expect(r.name).toBe('bank-vs-gl')
    expect(r.sources).toHaveLength(2)
    const fetched = await store.getRecipe('bank-vs-gl')
    expect(fetched?.name).toBe('bank-vs-gl')
    expect(fetched?.description).toBe('monthly recon')
    expect(fetched?.sources[0].alias).toBe('bank')
    expect(fetched?.sources[0].table).toBe('bank_aug')
    expect(fetched?.match_sql).toBe('SELECT 1')
    expect(fetched?.run_count).toBe(0)
  })

  it('listRecipes orders by created_at DESC', async () => {
    await store.addRecipe({ name: 'first', match_sql: 's', sources: [{ alias: 'a', table: 'x' }, { alias: 'b', table: 'y' }] })
    await new Promise(r => setTimeout(r, 5))
    await store.addRecipe({ name: 'second', match_sql: 's', sources: [{ alias: 'a', table: 'x' }, { alias: 'b', table: 'y' }] })
    const list = await store.listRecipes()
    expect(list.map(r => r.name)).toEqual(['second', 'first'])
  })

  it('deleteRecipe removes the row', async () => {
    await store.addRecipe({ name: 'x', match_sql: 's', sources: [{ alias: 'a', table: 'x' }, { alias: 'b', table: 'y' }] })
    await store.deleteRecipe('x')
    expect(await store.getRecipe('x')).toBeNull()
  })

  it('recordRun increments run_count and updates last_match_rate', async () => {
    await store.addRecipe({ name: 'r', match_sql: 's', sources: [{ alias: 'a', table: 'x' }, { alias: 'b', table: 'y' }] })
    await store.recordRun('r', 0.95)
    const fetched = await store.getRecipe('r')
    expect(fetched?.run_count).toBe(1)
    expect(fetched?.last_match_rate).toBeCloseTo(0.95)
    expect(fetched?.last_run_at).toBeTruthy()
  })

  it("escapes single quotes in name/sql", async () => {
    await store.addRecipe({
      name: "it's mine",
      match_sql: "SELECT 'x'",
      sources: [{ alias: 'a', table: 'x' }, { alias: 'b', table: 'y' }]
    })
    const fetched = await store.getRecipe("it's mine")
    expect(fetched?.match_sql).toBe("SELECT 'x'")
  })
})
