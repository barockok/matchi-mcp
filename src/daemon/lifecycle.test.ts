import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDaemonInfo, readDaemonInfo, isDaemonAlive, clearDaemonInfo, pickPort } from './lifecycle'

describe('lifecycle', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'matchi-life-'))
    process.env.MATCHI_HOME = home
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('writes and reads daemon info', () => {
    writeDaemonInfo({ pid: 1234, port: 9999, startedAt: 1, version: '0.0.1' })
    expect(readDaemonInfo()?.pid).toBe(1234)
  })

  it('returns null when no info', () => {
    expect(readDaemonInfo()).toBeNull()
  })

  it('clearDaemonInfo removes file', () => {
    writeDaemonInfo({ pid: 1, port: 1, startedAt: 1, version: 'x' })
    clearDaemonInfo()
    expect(readDaemonInfo()).toBeNull()
  })

  it('isDaemonAlive false for nonexistent pid', () => {
    expect(isDaemonAlive(999_999_999)).toBe(false)
  })

  it('isDaemonAlive true for current process', () => {
    expect(isDaemonAlive(process.pid)).toBe(true)
  })

  it('pickPort returns a free port number', async () => {
    const p = await pickPort()
    expect(p).toBeGreaterThan(1024)
    expect(p).toBeLessThan(65_536)
  })
})
