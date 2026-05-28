import type { FastifyPluginAsync } from 'fastify'
import type { MatchiServer } from '../server'

export const streamRoutes: FastifyPluginAsync = async (fastify) => {
  const f = fastify as MatchiServer

  f.get<{ Params: { hash: string }; Querystring: { id: string } }>(
    '/workspaces/:hash/stream',
    async (req, reply) => {
      const jobId = req.query.id
      if (!jobId) {
        return reply.code(400).send({ ok: false, error: { code: 'missing_job_id', message: 'id query param required' } })
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const unsubscribe = f.bus.subscribe(jobId, (event) => {
        reply.raw.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`)
      })
      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat\n\n`)
      }, 15_000)
      heartbeat.unref()
      req.raw.on('close', () => {
        unsubscribe()
        clearInterval(heartbeat)
        try { reply.raw.end() } catch { /* noop */ }
      })
      return reply
    }
  )
}
