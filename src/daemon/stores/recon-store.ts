import { randomUUID } from 'crypto'
import type { Engine } from '../db/engine'

export interface ReconRun {
  id: string
  name: string
  datasetIdA: string
  datasetIdB: string
  joinKey: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  config?: Record<string, unknown>
  summary?: ReconSummary
  error?: string
}

export interface ReconSummary {
  totalA: number
  totalB: number
  matched: number
  unmatchedA: number
  unmatchedB: number
  exceptions: number
}

export interface MatchResult {
  runId: string
  matchedPairs: Array<{ rowA: Record<string, unknown>; rowB: Record<string, unknown> }>
  exceptionsA: Array<Record<string, unknown>>
  exceptionsB: Array<Record<string, unknown>>
  exportDir?: string
  unmatchedAPath?: string
  unmatchedBPath?: string
}

export class ReconStore {
  private runs: Map<string, ReconRun> = new Map()
  private matchResults: Map<string, MatchResult> = new Map()
  private initialized = false

  constructor(private readonly engine: Engine) {}

  private esc(s: string): string {
    return s.replace(/'/g, "''")
  }

  async init(): Promise<void> {
    if (this.initialized) return
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS recon_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        datasets TEXT DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        trigger TEXT DEFAULT 'chat',
        recipe_id TEXT,
        matched INTEGER DEFAULT 0,
        unmatched_files TEXT DEFAULT '[]',
        match_rate REAL DEFAULT 0,
        matched_sql TEXT,
        text_summary TEXT,
        error TEXT,
        created_at TIMESTAMP DEFAULT current_timestamp
      )
    `)
    this.initialized = true
  }

  async persistRun(run: ReconRun, extras: {
    datasets: Array<{ role: string; id: string; name: string; row_count: number }>
    unmatchedFiles: Array<{ dataset_id: string; path: string; count: number }>
    matchedSql: string
    trigger: 'chat' | 'recipe'
    recipeId?: string
  }): Promise<void> {
    await this.init()
    const matchRate = run.summary
      ? Math.round(run.summary.matched / Math.max(run.summary.totalA, 1) * 1000) / 10
      : 0

    await this.engine.execute(`
      INSERT INTO recon_runs (id, name, datasets, status, trigger, recipe_id, matched, unmatched_files, match_rate, matched_sql, error, created_at)
      VALUES (
        '${this.esc(run.id)}',
        '${this.esc(run.name)}',
        '${this.esc(JSON.stringify(extras.datasets))}',
        '${this.esc(run.status)}',
        '${this.esc(extras.trigger)}',
        ${extras.recipeId ? `'${this.esc(extras.recipeId)}'` : 'NULL'},
        ${run.summary?.matched ?? 0},
        '${this.esc(JSON.stringify(extras.unmatchedFiles))}',
        ${matchRate},
        ${extras.matchedSql ? `'${this.esc(extras.matchedSql)}'` : 'NULL'},
        ${run.error ? `'${this.esc(run.error)}'` : 'NULL'},
        '${run.createdAt}'
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        matched = EXCLUDED.matched,
        unmatched_files = EXCLUDED.unmatched_files,
        match_rate = EXCLUDED.match_rate,
        trigger = EXCLUDED.trigger,
        recipe_id = EXCLUDED.recipe_id,
        error = EXCLUDED.error
    `)
  }

  async updateSummaryText(runId: string, summary: string): Promise<void> {
    await this.init()
    await this.engine.execute(`UPDATE recon_runs SET text_summary = '${this.esc(summary)}' WHERE id = '${this.esc(runId)}'`)
  }

  async listPersistedRuns(limit = 20): Promise<Record<string, unknown>[]> {
    await this.init()
    return this.engine.query(`SELECT * FROM recon_runs ORDER BY created_at DESC LIMIT ${limit}`)
  }

  async getPersistedRun(id: string): Promise<Record<string, unknown> | null> {
    await this.init()
    const rows = await this.engine.query(`SELECT * FROM recon_runs WHERE id = '${this.esc(id)}'`)
    return rows.length > 0 ? rows[0] : null
  }

  addRun(params: {
    name: string
    datasetIdA: string
    datasetIdB: string
    joinKey: string
    config?: Record<string, unknown>
  }): ReconRun {
    const now = new Date().toISOString()
    const run: ReconRun = {
      id: randomUUID(),
      name: params.name,
      datasetIdA: params.datasetIdA,
      datasetIdB: params.datasetIdB,
      joinKey: params.joinKey,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      config: params.config
    }
    this.runs.set(run.id, run)
    return run
  }

  getRun(id: string): ReconRun | undefined {
    return this.runs.get(id)
  }

  listRuns(): ReconRun[] {
    return Array.from(this.runs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }

  updateRun(id: string, data: Partial<ReconRun>): ReconRun {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Run not found: ${id}`)
    const updated = { ...run, ...data, updatedAt: new Date().toISOString() }
    this.runs.set(id, updated)
    return updated
  }

  setMatchResult(runId: string, result: MatchResult): void {
    this.matchResults.set(runId, result)
  }

  getMatchResult(runId: string): MatchResult | undefined {
    return this.matchResults.get(runId)
  }
}
