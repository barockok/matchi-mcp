import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Engine } from './engine'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Engine', () => {
  let dir: string
  let engine: Engine

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'matchi-engine-'))
    engine = new Engine(join(dir, 'data.duckdb'))
    await engine.init()
  })
  afterEach(async () => {
    await engine.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs SELECT', async () => {
    const rows = await engine.query('SELECT 1 AS n')
    expect(rows).toEqual([{ n: 1 }])
  })

  it('converts bigints in safe integer range to number', async () => {
    const rows = await engine.query("SELECT 42::BIGINT AS n")
    expect(rows[0].n).toBe(42)
    expect(typeof rows[0].n).toBe('number')
  })

  it('persists across reopen', async () => {
    await engine.execute("CREATE TABLE t (x INT)")
    await engine.execute("INSERT INTO t VALUES (7)")
    await engine.close()
    engine = new Engine(join(dir, 'data.duckdb'))
    await engine.init()
    const rows = await engine.query("SELECT * FROM t")
    expect(rows).toEqual([{ x: 7 }])
  })
})
