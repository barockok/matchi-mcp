import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const SHIM = resolve(__dirname, '..', '..', 'bin', 'matchi.js')
const BANK = resolve(__dirname, '..', 'fixtures', 'bank.csv')
const GL = resolve(__dirname, '..', 'fixtures', 'gl.csv')

interface ToolResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

function parse<T = unknown>(r: { content: unknown }): ToolResult<T> {
  const content = r.content as { type: string; text: string }[]
  return JSON.parse(content[0].text) as ToolResult<T>
}

describe('end-to-end recon through MCP shim', () => {
  let home: string
  let client: Client
  let transport: StdioClientTransport

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-e2e-'))
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SHIM],
      env: {
        ...(process.env as Record<string, string>),
        MATCHI_HOME: home,
        MATCHI_IDLE_MS: '120000'
      }
    })
    client = new Client({ name: 'e2e-test', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transport)
  }, 20_000)

  afterAll(async () => {
    try {
      await client.close()
    } catch {
      /* noop */
    }
    const dj = join(home, 'daemon.json')
    if (existsSync(dj)) {
      try {
        const info = JSON.parse(readFileSync(dj, 'utf8')) as { pid: number }
        try {
          process.kill(info.pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      } catch {
        /* noop */
      }
    }
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }, 10_000)

  it('lists 7 tools', async () => {
    const r = await client.listTools()
    expect(r.tools.length).toBe(7)
    const names = r.tools.map(t => t.name).sort()
    expect(names).toEqual([
      'get_exceptions',
      'list_sources',
      'load_sheet',
      'recall_known_mistakes',
      'run_match',
      'run_sql',
      'upload_dataset'
    ])
  })

  it('runs the full recon flow', async () => {
    // Step 0: recall known mistakes (empty)
    const r0 = parse<{ patterns: unknown[] }>(
      await client.callTool({ name: 'recall_known_mistakes', arguments: {} })
    )
    expect(r0.ok).toBe(true)
    expect(Array.isArray(r0.data!.patterns)).toBe(true)

    // Step 1: upload datasets
    const r1a = parse<{ table_name: string; rows: number }>(
      await client.callTool({ name: 'upload_dataset', arguments: { path: BANK, alias: 'bank' } })
    )
    expect(r1a.ok).toBe(true)
    expect(r1a.data!.rows).toBe(10)
    const bankTable = r1a.data!.table_name

    const r1b = parse<{ table_name: string; rows: number }>(
      await client.callTool({ name: 'upload_dataset', arguments: { path: GL, alias: 'gl' } })
    )
    expect(r1b.ok).toBe(true)
    expect(r1b.data!.rows).toBe(10)
    const glTable = r1b.data!.table_name

    // Step 2: list_sources reflects both
    const r2 = parse<{ sources: Array<{ table: string }> }>(
      await client.callTool({ name: 'list_sources', arguments: {} })
    )
    expect(r2.ok).toBe(true)
    const sourceTables = r2.data!.sources.map(s => s.table).sort()
    expect(sourceTables).toContain(bankTable)
    expect(sourceTables).toContain(glTable)

    // Step 3: discovery via batched run_sql
    const r3 = parse(
      await client.callTool({
        name: 'run_sql',
        arguments: {
          queries: [
            { sql: `SELECT COUNT(*) AS n FROM ${bankTable}` },
            { sql: `SELECT COUNT(*) AS n FROM ${glTable}` }
          ]
        }
      })
    )
    expect(r3.ok).toBe(true)

    // Step 4: run_match
    const matchedSql = `
      SELECT a.id AS a_id, b.id AS b_id, a.txn_ref
      FROM ${bankTable} AS a
      JOIN ${glTable} AS b USING (txn_ref)
    `
    const r4 = parse<{
      matchRunId: string
      matched: number
      unmatchedA: number
      unmatchedB: number
      totalExceptions: number
    }>(
      await client.callTool({
        name: 'run_match',
        arguments: { matched_sql: matchedSql, a: bankTable, b: glTable }
      })
    )
    expect(r4.ok).toBe(true)
    expect(r4.data!.matched).toBe(7)
    expect(r4.data!.unmatchedA).toBe(3)
    expect(r4.data!.unmatchedB).toBe(3)
    expect(r4.data!.totalExceptions).toBe(6)
    const runId = r4.data!.matchRunId
    expect(typeof runId).toBe('string')
    expect(runId.length).toBeGreaterThan(0)

    // Step 5: paginate exceptions
    const r5a = parse<{ exceptions: unknown[]; total: number; page: number; page_size: number }>(
      await client.callTool({
        name: 'get_exceptions',
        arguments: { match_run_id: runId, side: 'a', page: 0, page_size: 50 }
      })
    )
    expect(r5a.ok).toBe(true)
    expect(r5a.data!.exceptions.length).toBe(3)
    expect(r5a.data!.total).toBe(3)

    const r5b = parse<{ exceptions: unknown[]; total: number }>(
      await client.callTool({
        name: 'get_exceptions',
        arguments: { match_run_id: runId, side: 'b', page: 0, page_size: 50 }
      })
    )
    expect(r5b.ok).toBe(true)
    expect(r5b.data!.exceptions.length).toBe(3)
    expect(r5b.data!.total).toBe(3)
  }, 30_000)
})
