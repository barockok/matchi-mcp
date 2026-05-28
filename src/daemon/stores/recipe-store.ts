import { randomUUID } from 'crypto'
import type { Engine } from '../db/engine'

export interface Recipe {
  id: string
  name: string
  matched_sql: string
  dataset_a_pattern: string
  dataset_b_pattern: string
  match_rate: number | null
  matched_count: number | null
  total_count: number | null
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  last_run_at: string | null
  run_count: number
}

const esc = (s: string) => s.replace(/'/g, "''")

export class RecipeStore {
  private initialized = false

  constructor(private readonly engine: Engine) {}

  async init(): Promise<void> {
    if (this.initialized) return
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        matched_sql TEXT NOT NULL,
        dataset_a_pattern TEXT,
        dataset_b_pattern TEXT,
        match_rate DOUBLE,
        matched_count INTEGER,
        total_count INTEGER,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        run_count INTEGER DEFAULT 0
      )
    `)
    this.initialized = true
  }

  async addRecipe(params: {
    name: string
    matched_sql: string
    dataset_a_pattern: string
    dataset_b_pattern: string
    matched_count?: number
    total_count?: number
  }): Promise<Recipe> {
    await this.init()
    const id = randomUUID()
    const now = new Date().toISOString()
    const matchRate = params.matched_count != null && params.total_count
      ? params.matched_count / params.total_count
      : null

    await this.engine.execute(`
      INSERT INTO recipes (id, name, matched_sql, dataset_a_pattern, dataset_b_pattern, match_rate, matched_count, total_count, status, created_at, updated_at, last_run_at, run_count)
      VALUES (
        '${esc(id)}',
        '${esc(params.name)}',
        '${esc(params.matched_sql)}',
        '${esc(params.dataset_a_pattern)}',
        '${esc(params.dataset_b_pattern)}',
        ${matchRate ?? 'NULL'},
        ${params.matched_count ?? 'NULL'},
        ${params.total_count ?? 'NULL'},
        'active',
        '${now}',
        '${now}',
        NULL,
        0
      )
    `)

    return {
      id, name: params.name, matched_sql: params.matched_sql,
      dataset_a_pattern: params.dataset_a_pattern,
      dataset_b_pattern: params.dataset_b_pattern,
      match_rate: matchRate, matched_count: params.matched_count ?? null,
      total_count: params.total_count ?? null, status: 'active',
      created_at: now, updated_at: now, last_run_at: null, run_count: 0
    }
  }

  async getRecipe(id: string): Promise<Recipe | null> {
    await this.init()
    const rows = await this.engine.query(`SELECT * FROM recipes WHERE id = '${esc(id)}'`)
    return rows.length > 0 ? (rows[0] as unknown as Recipe) : null
  }

  async listRecipes(): Promise<Recipe[]> {
    await this.init()
    const rows = await this.engine.query(`SELECT * FROM recipes WHERE status = 'active' ORDER BY updated_at DESC`)
    return rows as unknown as Recipe[]
  }

  async deleteRecipe(id: string): Promise<void> {
    await this.init()
    const now = new Date().toISOString()
    await this.engine.execute(`UPDATE recipes SET status = 'archived', updated_at = '${now}' WHERE id = '${esc(id)}'`)
  }

  async recordRun(id: string, matchRate?: number): Promise<void> {
    await this.init()
    const now = new Date().toISOString()
    const matchRateClause = matchRate != null ? `, match_rate = ${matchRate}` : ''
    await this.engine.execute(`UPDATE recipes SET run_count = run_count + 1, last_run_at = '${now}', updated_at = '${now}'${matchRateClause} WHERE id = '${esc(id)}'`)
  }
}
