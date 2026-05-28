import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from './doctor'

describe('doctor', () => {
  let home: string
  let origHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'matchi-doc-'))
    origHome = process.env.MATCHI_HOME
    process.env.MATCHI_HOME = home
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    if (origHome === undefined) delete process.env.MATCHI_HOME
    else process.env.MATCHI_HOME = origHome
  })

  function captureLogs(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    return { lines, restore: () => { console.log = orig } }
  }

  it('exits 0 when no daemon and no workspaces', async () => {
    const cap = captureLogs()
    try {
      const code = await doctor()
      expect(code).toBe(0)
      expect(cap.lines.some(l => l.includes('not running'))).toBe(true)
      expect(cap.lines.some(l => l.includes('(none)'))).toBe(true)
    } finally {
      cap.restore()
    }
  })

  it('lists workspaces and reports stale pid as unhealthy', async () => {
    // Stale daemon.json pointing to a likely-dead pid
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({ pid: 999_999_999, port: 1, startedAt: Date.now(), version: '0.0.1' })
    )
    const wsDir = join(home, 'workspaces', 'abc123')
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(join(wsDir, 'data.duckdb'), 'x'.repeat(2048))

    const cap = captureLogs()
    try {
      const code = await doctor()
      expect(code).toBe(1)
      expect(cap.lines.some(l => l.includes('abc123'))).toBe(true)
      expect(cap.lines.some(l => l.includes('healthy:     no'))).toBe(true)
    } finally {
      cap.restore()
    }
  })
})
