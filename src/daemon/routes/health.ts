import type { FastifyPluginAsync } from 'fastify'
import type { MatchiServer } from '../server'

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const f = fastify as MatchiServer
  f.get('/healthz', async () => {
    return {
      ok: true,
      version: f.matchiVersion,
      uptime_s: Math.floor((Date.now() - f.startedAt) / 1000)
    }
  })

  // Minimal handshake endpoint used by the stdio shim's ensureToken probe.
  // The auth preHandler calls registry.touch() (which writes the per-workspace
  // token file) before the bearer check rejects, so even a 401 here is enough
  // to materialize the file. Returning 200 here when a valid bearer is
  // present keeps integration tests simpler.
  f.get<{ Params: { hash: string } }>('/v1/workspaces/:hash/touch', async () => {
    return { ok: true }
  })

  // Graceful shutdown invoked by `matchi stop`.
  f.post('/v1/shutdown', async (_req, reply) => {
    reply.send({ ok: true, data: { shutting_down: true } })
    setTimeout(() => f.close().then(() => process.exit(0)), 50)
  })
}
