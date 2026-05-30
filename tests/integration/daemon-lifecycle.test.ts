import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer, type MatchiServer } from '../../src/daemon/server'

describe('daemon HTTP', () => {
  let home: string
  let server: MatchiServer

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-it-'))
    process.env.MATCHI_HOME = home
    server = await buildServer({ idleTimeoutMs: 60_000 })
    await server.listen({ port: 0, host: '127.0.0.1' })
  })
  afterEach(async () => {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('GET /healthz returns ok with version + uptime', async () => {
    const r = await server.inject({ method: 'GET', url: '/healthz' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
    expect(typeof body.uptime_s).toBe('number')
  })

  it('rejects tool call without bearer', async () => {
    const r = await server.inject({
      method: 'POST',
      url: '/v1/workspaces/abc123def456/tools/list_sources',
      payload: {}
    })
    expect(r.statusCode).toBe(401)
  })

  it('accepts tool call with correct bearer (list_sources empty)', async () => {
    const hash = 'abcdef012345'
    const stores = await server.storesFor(hash)
    const token = stores.ws.token

    const r = await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${hash}/tools/list_sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {}
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.sources)).toBe(true)
  })

  it('returns 404 for unknown tool', async () => {
    const hash = 'cafebabe0000'
    const stores = await server.storesFor(hash)
    const r = await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${hash}/tools/nope`,
      headers: { authorization: `Bearer ${stores.ws.token}` },
      payload: {}
    })
    expect(r.statusCode).toBe(404)
  })

  it('returns 400 for invalid args (run_sql with neither sql nor queries)', async () => {
    const hash = 'deadbeef0000'
    const stores = await server.storesFor(hash)
    const r = await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${hash}/tools/run_sql`,
      headers: { authorization: `Bearer ${stores.ws.token}` },
      payload: {}
    })
    expect(r.statusCode).toBe(400)
  })

  it('GET /v1/workspaces/:hash/touch materializes the token', async () => {
    const hash = 'f00ba2000000'
    const stores = await server.storesFor(hash)
    const r = await server.inject({
      method: 'GET',
      url: `/v1/workspaces/${hash}/touch`,
      headers: { authorization: `Bearer ${stores.ws.token}` }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().ok).toBe(true)
  })
})
