import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const SHIM_BIN = resolve(__dirname, '..', '..', 'bin', 'matchi-mcp.js')

const EXPECTED_TOOLS = [
  'upload_dataset',
  'list_sources',
  'load_sheet',
  'run_sql',
  'run_match',
  'get_exceptions',
  'recall_known_mistakes'
] as const

describe('matchi-mcp stdio shim', () => {
  let home: string
  let client: Client
  let transport: StdioClientTransport

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-mcp-shim-it-'))
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SHIM_BIN],
      env: {
        ...(process.env as Record<string, string>),
        MATCHI_HOME: home,
        MATCHI_IDLE_MS: '60000'
      }
    })
    client = new Client({ name: 'shim-test', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transport)
  }, 20_000)

  afterAll(async () => {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
    // Kill the spawned daemon, if any
    const infoPath = join(home, 'daemon.json')
    if (existsSync(infoPath)) {
      try {
        const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { pid: number }
        try {
          process.kill(info.pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      } catch {
        /* ignore */
      }
    }
    // Give the daemon a moment to clean up
    await sleep(200)
    rmSync(home, { recursive: true, force: true })
  }, 10_000)

  it('lists all seven tools', async () => {
    const r = await client.listTools()
    const names = r.tools.map((t) => t.name).sort()
    expect(names).toEqual([...EXPECTED_TOOLS].sort())
    // Each tool has an inputSchema object
    for (const t of r.tools) {
      expect(t.inputSchema).toBeTypeOf('object')
    }
  })

  it('callTool recall_known_mistakes returns ok envelope', async () => {
    const r = await client.callTool({ name: 'recall_known_mistakes', arguments: {} })
    expect(r.isError).toBeFalsy()
    const content = (r.content as { type: string; text: string }[])[0]
    expect(content.type).toBe('text')
    const parsed = JSON.parse(content.text)
    expect(parsed.ok).toBe(true)
    expect(Array.isArray(parsed.data.patterns)).toBe(true)
  })

  it('callTool list_sources returns empty sources for a fresh workspace', async () => {
    const r = await client.callTool({ name: 'list_sources', arguments: {} })
    expect(r.isError).toBeFalsy()
    const content = (r.content as { type: string; text: string }[])[0]
    const parsed = JSON.parse(content.text)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.sources).toEqual([])
  })
})
