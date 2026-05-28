import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Engine } from '../db/engine'
import { ErrorMemoryStore } from './error-memory-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ErrorMemoryStore', () => {
  let dir: string
  let engine: Engine
  let store: ErrorMemoryStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'matchi-errmem-'))
    engine = new Engine(join(dir, 'meta.duckdb'))
    await engine.init()
    store = new ErrorMemoryStore(engine)
    await store.init()
  })
  afterEach(async () => {
    await engine.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records a new error and classifies category', async () => {
    await store.recordError('run_sql', 'Parser Error: near "FROM"', 'SELECT FROM t')
    const all = await store.listAll()
    expect(all).toHaveLength(1)
    expect(all[0].tool_name).toBe('run_sql')
    expect(all[0].error_category).toBe('syntax')
    expect(all[0].occurrence_count).toBe(1)
  })

  it('dedups by (tool, category) and increments occurrence_count', async () => {
    await store.recordError('run_sql', 'Parser Error: a', 'sql 1')
    await store.recordError('run_sql', 'Parser Error: b', 'sql 2')
    await store.recordError('run_sql', 'table does not exist', 'sql 3')
    const all = await store.listAll()
    // 2 distinct categories: syntax (2x) and not_found (1x)
    expect(all).toHaveLength(2)
    const syntax = all.find(p => p.error_category === 'syntax')!
    expect(syntax.occurrence_count).toBe(2)
    expect(syntax.latest_error_message).toBe('Parser Error: b')
    expect(syntax.latest_input_summary).toBe('sql 2')
  })

  it('getTopPatterns orders by occurrence_count DESC', async () => {
    await store.recordError('run_sql', 'Parser Error: x', 'a')
    await store.recordError('run_sql', 'Parser Error: x', 'a')
    await store.recordError('load_sheet', 'file not found', 'b')
    const top = await store.getTopPatterns(10)
    expect(top[0].tool_name).toBe('run_sql')
    expect(top[0].occurrence_count).toBe(2)
    expect(top[1].tool_name).toBe('load_sheet')
  })

  it('recordCorrection attaches a lesson to the latest matching pattern', async () => {
    await store.recordError('run_sql', 'Parser Error: foo', 'SELECT * FROM bad')
    await store.recordCorrection('run_sql', 'SELECT * FROM good')
    const all = await store.listAll()
    expect(all[0].correction_lesson).toContain('Instead of')
    expect(all[0].correction_input_summary).toBe('SELECT * FROM good')
  })

  it('expireOldPatterns deletes rows older than 30 days', async () => {
    await store.recordError('run_sql', 'Parser Error: x', 'a')
    // Backdate the row to 40 days ago
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await engine.execute(`UPDATE error_patterns SET last_seen_at = '${old}'`)
    await store.expireOldPatterns()
    const all = await store.listAll()
    expect(all).toHaveLength(0)
  })

  it('buildPromptSection returns empty string when no patterns', async () => {
    const section = await store.buildPromptSection()
    expect(section).toBe('')
  })

  it('buildPromptSection includes recorded errors', async () => {
    await store.recordError('run_sql', 'Parser Error: near FROM', 'SELECT FROM t')
    const section = await store.buildPromptSection()
    expect(section).toContain('Common Mistakes to Avoid')
    expect(section).toContain('run_sql')
  })
})
