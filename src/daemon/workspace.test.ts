import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from './workspace'

describe('WorkspaceRegistry', () => {
  let home: string
  let reg: WorkspaceRegistry

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'matchi-ws-'))
    process.env.MATCHI_HOME = home
    reg = new WorkspaceRegistry({ idleTimeoutMs: 60_000 })
  })
  afterEach(async () => {
    await reg.closeAll()
    rmSync(home, { recursive: true, force: true })
  })

  it('lazy-creates dir, token, and engine on first touch', async () => {
    const ws = await reg.touch('abc123def456')
    expect(ws.hash).toBe('abc123def456')
    expect(statSync(join(home, 'workspaces', 'abc123def456')).isDirectory()).toBe(true)
    const token = readFileSync(join(home, 'workspaces', 'abc123def456', '.token'), 'utf8')
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(ws.token).toBe(token)
  })

  it('returns same instance on repeat touch', async () => {
    const a = await reg.touch('hash000000aa')
    const b = await reg.touch('hash000000aa')
    expect(a).toBe(b)
  })

  it('validates token', async () => {
    const ws = await reg.touch('hash000000bb')
    expect(reg.verifyToken('hash000000bb', ws.token)).toBe(true)
    expect(reg.verifyToken('hash000000bb', 'wrong')).toBe(false)
  })
})
