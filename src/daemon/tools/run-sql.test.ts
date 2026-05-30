import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from '../workspace'
import { ReconStore } from '../stores/recon-store'
import { RecipeStore } from '../stores/recipe-store'
import { ErrorMemoryStore } from '../stores/error-memory-store'
import { runSql } from './run-sql'
import type { ToolContext } from './types'

describe('run_sql', () => {
  let home: string
  let reg: WorkspaceRegistry
  let ctx: ToolContext

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-runsql-'))
    process.env.MATCHI_HOME = home
    reg = new WorkspaceRegistry({ idleTimeoutMs: 60_000 })
    const ws = await reg.touch('test00000001')
    const recon = new ReconStore(ws.meta); await recon.init()
    const recipe = new RecipeStore(ws.meta); await recipe.init()
    const errorMemory = new ErrorMemoryStore(ws.meta); await errorMemory.init()
    await ws.data.execute(`CREATE TABLE t (id INT, name TEXT)`)
    for (let i = 1; i <= 25; i++) {
      await ws.data.execute(`INSERT INTO t VALUES (${i}, 'name${i}')`)
    }
    ctx = { ws, recon, recipe, errorMemory }
  })

  afterEach(async () => {
    await reg.closeAll()
    rmSync(home, { recursive: true, force: true })
  })

  it('SELECT happy path returns <=20 rows with truncated flag', async () => {
    const res = await runSql.run({ sql: 'SELECT * FROM t' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    const data = res.data as { rows: unknown[]; totalRows: number; truncated: boolean }
    expect(data.rows.length).toBe(20)
    expect(data.totalRows).toBe(25)
    expect(data.truncated).toBe(true)
  })

  it('rejects DROP keyword', async () => {
    const res = await runSql.run({ sql: 'DROP TABLE t' }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe('dangerous_keyword')
  })

  it('batch of 2 queries returns array', async () => {
    const res = await runSql.run(
      {
        queries: [
          { sql: 'SELECT 1 AS x' },
          { sql: 'SELECT 2 AS y' }
        ]
      },
      ctx
    )
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    const data = res.data as { results: unknown[]; successCount: number; errorCount: number }
    expect(data.results).toHaveLength(2)
    expect(data.successCount).toBe(2)
    expect(data.errorCount).toBe(0)
  })

  it('count_only returns totalRows without rows', async () => {
    const res = await runSql.run({ sql: 'SELECT * FROM t', count_only: true }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect((res.data as { totalRows: number }).totalRows).toBe(25)
  })
})
