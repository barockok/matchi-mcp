import type { Engine } from '../db/engine'

export interface RecipeSource {
  alias: string
  table: string
}

export interface Recipe {
  name: string
  description: string | null
  match_sql: string
  sources: RecipeSource[]
  created_at: string
  last_run_at: string | null
  last_match_rate: number | null
  run_count: number
}

const esc = (s: string) => s.replace(/'/g, "''")

export class RecipeStore {
  private initialized = false

  constructor(private readonly engine: Engine) {}

  async init(): Promise<void> {
    if (this.initialized) return
    // Workspaces are local + ephemeral; recreating from scratch is fine for v0.2.0
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS recipes (
        name TEXT PRIMARY KEY,
        description TEXT,
        match_sql TEXT NOT NULL,
        sources TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_run_at TEXT,
        last_match_rate DOUBLE,
        run_count INTEGER DEFAULT 0
      )
    `)
    this.initialized = true
  }

  private parseRow(row: Record<string, unknown>): Recipe {
    let sources: RecipeSource[] = []
    try {
      sources = JSON.parse(String(row.sources ?? '[]')) as RecipeSource[]
    } catch {
      sources = []
    }
    return {
      name: String(row.name),
      description: row.description == null ? null : String(row.description),
      match_sql: String(row.match_sql),
      sources,
      created_at: String(row.created_at),
      last_run_at: row.last_run_at == null ? null : String(row.last_run_at),
      last_match_rate:
        row.last_match_rate == null ? null : Number(row.last_match_rate),
      run_count: Number(row.run_count ?? 0)
    }
  }

  async addRecipe(params: {
    name: string
    match_sql: string
    sources: RecipeSource[]
    description?: string | null
  }): Promise<Recipe> {
    await this.init()
    const now = new Date().toISOString()
    const descLit = params.description == null ? 'NULL' : `'${esc(params.description)}'`
    const sourcesJson = JSON.stringify(params.sources)
    await this.engine.execute(`
      INSERT INTO recipes (name, description, match_sql, sources, created_at, last_run_at, last_match_rate, run_count)
      VALUES ('${esc(params.name)}', ${descLit}, '${esc(params.match_sql)}', '${esc(sourcesJson)}', '${now}', NULL, NULL, 0)
    `)
    return {
      name: params.name,
      description: params.description ?? null,
      match_sql: params.match_sql,
      sources: params.sources,
      created_at: now,
      last_run_at: null,
      last_match_rate: null,
      run_count: 0
    }
  }

  async getRecipe(name: string): Promise<Recipe | null> {
    await this.init()
    const rows = (await this.engine.query(
      `SELECT * FROM recipes WHERE name = '${esc(name)}'`
    )) as Record<string, unknown>[]
    return rows.length > 0 ? this.parseRow(rows[0]) : null
  }

  async listRecipes(): Promise<Recipe[]> {
    await this.init()
    const rows = (await this.engine.query(
      `SELECT * FROM recipes ORDER BY created_at DESC`
    )) as Record<string, unknown>[]
    return rows.map(r => this.parseRow(r))
  }

  async deleteRecipe(name: string): Promise<void> {
    await this.init()
    await this.engine.execute(`DELETE FROM recipes WHERE name = '${esc(name)}'`)
  }

  async recordRun(name: string, matchRate?: number): Promise<void> {
    await this.init()
    const now = new Date().toISOString()
    const rateClause = matchRate != null ? `, last_match_rate = ${matchRate}` : ''
    await this.engine.execute(
      `UPDATE recipes SET run_count = run_count + 1, last_run_at = '${now}'${rateClause} WHERE name = '${esc(name)}'`
    )
  }
}
