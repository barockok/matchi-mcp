import type { FastifyPluginAsync } from 'fastify'
import type { MatchiServer } from '../server'

export const stateRoutes: FastifyPluginAsync = async (fastify) => {
  const f = fastify as MatchiServer

  f.get<{ Params: { hash: string } }>('/workspaces/:hash/state', async (req) => {
    const { hash } = req.params
    const stores = await f.storesFor(hash)
    const sources = await stores.ws.meta.query(`SELECT name, alias, uploaded_at FROM sources`).catch(() => [])
    let runs: unknown[] = []
    try { runs = stores.recon.listRuns() } catch { runs = [] }
    return { ok: true, data: { sources, runs: runs.slice(0, 10) } }
  })

  f.post('/shutdown', async (_req, reply) => {
    reply.send({ ok: true, data: { shutting_down: true } })
    setTimeout(() => f.close().then(() => process.exit(0)), 50)
  })
}
