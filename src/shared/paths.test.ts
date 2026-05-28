import { describe, it, expect, beforeEach } from 'vitest'
import { matchiHome, workspaceDir, daemonInfoPath } from './paths'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('paths', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'matchi-'))
    process.env.MATCHI_HOME = home
  })
  it('matchiHome respects MATCHI_HOME', () => {
    expect(matchiHome()).toBe(home)
  })
  it('workspaceDir nests under workspaces/<hash>', () => {
    expect(workspaceDir('abc123')).toBe(join(home, 'workspaces', 'abc123'))
  })
  it('daemonInfoPath is <home>/daemon.json', () => {
    expect(daemonInfoPath()).toBe(join(home, 'daemon.json'))
  })
})
