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
}
