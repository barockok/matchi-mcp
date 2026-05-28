import { describe, it, expect } from 'vitest'
import { workspaceHash } from './hash'

describe('workspaceHash', () => {
  it('produces 12-char hex sha1 prefix', () => {
    const h = workspaceHash('/Users/foo/proj')
    expect(h).toMatch(/^[a-f0-9]{12}$/)
  })
  it('is deterministic', () => {
    expect(workspaceHash('/x')).toBe(workspaceHash('/x'))
  })
  it('differs for different cwds', () => {
    expect(workspaceHash('/a')).not.toBe(workspaceHash('/b'))
  })
})
