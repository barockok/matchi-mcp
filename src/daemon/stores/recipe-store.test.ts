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

  it('inserts and reads a recipe', async () => {
    const r = await store.addRecipe({
      name: 'A vs B',
      matched_sql: 'SELECT 1',
      dataset_a_pattern: 'bank_*',
      dataset_b_pattern: 'gl_*',
      matched_count: 80,
      total_count: 100,
    })
    expect(r.id).toBeTruthy()
    expect(r.match_rate).toBeCloseTo(0.8)
    const fetched = await store.getRecipe(r.id)
    expect(fetched?.name).toBe('A vs B')
    expect(fetched?.status).toBe('active')
  })

  it('listRecipes excludes archived and orders by updated_at DESC', async () => {
    const r1 = await store.addRecipe({ name: 'first', matched_sql: 's', dataset_a_pattern: 'a', dataset_b_pattern: 'b' })
    await new Promise(r => setTimeout(r, 5))
    const r2 = await store.addRecipe({ name: 'second', matched_sql: 's', dataset_a_pattern: 'a', dataset_b_pattern: 'b' })
    await store.deleteRecipe(r1.id)
    const list = await store.listRecipes()
    expect(list.map(r => r.id)).toEqual([r2.id])
  })

  it('recordRun increments count and updates match_rate', async () => {
    const r = await store.addRecipe({ name: 'x', matched_sql: 's', dataset_a_pattern: 'a', dataset_b_pattern: 'b' })
    await store.recordRun(r.id, 0.95)
    const updated = await store.getRecipe(r.id)
    expect(updated?.run_count).toBe(1)
    expect(updated?.match_rate).toBeCloseTo(0.95)
    expect(updated?.last_run_at).toBeTruthy()
  })

  it('escapes single quotes in name/sql', async () => {
    const r = await store.addRecipe({
      name: "it's mine",
      matched_sql: "SELECT 'x'",
      dataset_a_pattern: 'a',
      dataset_b_pattern: 'b',
    })
    const fetched = await store.getRecipe(r.id)
    expect(fetched?.name).toBe("it's mine")
    expect(fetched?.matched_sql).toBe("SELECT 'x'")
  })
})
