import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Engine } from '../db/engine'
import { ReconStore } from './recon-store'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ReconStore', () => {
  let dir: string
  let engine: Engine
  let store: ReconStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'matchi-recon-'))
    engine = new Engine(join(dir, 'meta.duckdb'))
    await engine.init()
    store = new ReconStore(engine, { auditDir: join(dir, 'logs') })
    await store.init()
  })
  afterEach(async () => {
    await engine.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('addRun / getRun / updateRun maintain in-memory state', () => {
    const run = store.addRun({ name: 'r1', datasetIdA: 'a', datasetIdB: 'b', joinKey: 'id' })
    expect(store.getRun(run.id)?.status).toBe('pending')
    const upd = store.updateRun(run.id, { status: 'completed' })
    expect(upd.status).toBe('completed')
  })

  it('listRuns orders by createdAt DESC', async () => {
    const r1 = store.addRun({ name: 'a', datasetIdA: 'x', datasetIdB: 'y', joinKey: 'k' })
    await new Promise(r => setTimeout(r, 5))
    const r2 = store.addRun({ name: 'b', datasetIdA: 'x', datasetIdB: 'y', joinKey: 'k' })
    expect(store.listRuns().map(r => r.id)).toEqual([r2.id, r1.id])
  })

  it('persistRun writes and re-reads', async () => {
    const run = store.addRun({ name: 'pr', datasetIdA: 'a', datasetIdB: 'b', joinKey: 'k' })
    const updated = store.updateRun(run.id, {
      status: 'completed',
      summary: { totalA: 100, totalB: 100, matched: 90, unmatchedA: 10, unmatchedB: 10, exceptions: 20 }
    })
    await store.persistRun(updated, {
      datasets: [{ role: 'A', id: 'a', name: 'A', row_count: 100 }],
      unmatchedFiles: [],
      matchedSql: 'SELECT 1',
      trigger: 'chat',
    })
    const fetched = await store.getPersistedRun(run.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.matched).toBe(90)
    expect(fetched?.match_rate).toBe(90)
  })

  it('persistRun upserts (ON CONFLICT) updates status', async () => {
    const run = store.addRun({ name: 'u', datasetIdA: 'a', datasetIdB: 'b', joinKey: 'k' })
    await store.persistRun(run, { datasets: [], unmatchedFiles: [], matchedSql: '', trigger: 'chat' })
    const final = store.updateRun(run.id, { status: 'failed', error: 'boom' })
    await store.persistRun(final, { datasets: [], unmatchedFiles: [], matchedSql: '', trigger: 'chat' })
    const list = await store.listPersistedRuns(10)
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('failed')
    expect(list[0].error).toBe('boom')
  })

  it('getExceptions slices match results by side', () => {
    const run = store.addRun({ name: 'e', datasetIdA: 'a', datasetIdB: 'b', joinKey: 'k' })
    store.setMatchResult(run.id, {
      runId: run.id,
      matchedPairs: [],
      exceptionsA: [{ id: 1 }, { id: 2 }],
      exceptionsB: [{ id: 3 }],
    })
    expect(store.getExceptions(run.id, 'A')).toEqual([{ id: 1 }, { id: 2 }])
    expect(store.getExceptions(run.id, 'B')).toEqual([{ id: 3 }])
    const all = store.getExceptions(run.id, 'all')
    expect(all).toHaveLength(3)
    expect(all[0]).toMatchObject({ id: 1, _side: 'A' })
  })

  it('audit writes entries readable via getAuditLog', () => {
    const run = store.addRun({ name: 'au', datasetIdA: 'a', datasetIdB: 'b', joinKey: 'k' })
    store.audit('match_completed', run.id, 'details here')
    expect(existsSync(join(dir, 'logs', 'audit-trail.jsonl'))).toBe(true)
    const log = store.getAuditLog(10)
    expect(log).toHaveLength(1)
    expect(log[0].action).toBe('match_completed')
    expect(log[0].runName).toBe('au')
  })

  it('audit is a no-op when auditDir is not configured', () => {
    const ephemeral = new ReconStore(engine)
    expect(() => ephemeral.audit('noop')).not.toThrow()
    expect(ephemeral.getAuditLog()).toEqual([])
  })
})
