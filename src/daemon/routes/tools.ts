import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { TOOLS } from '../tools'
import type { MatchiServer } from '../server'

export const toolsRoutes: FastifyPluginAsync = async (fastify) => {
  const f = fastify as MatchiServer

  f.post<{ Params: { hash: string; name: string }; Body: Record<string, unknown> }>(
    '/workspaces/:hash/tools/:name',
    async (req, reply) => {
      const { hash, name } = req.params
      const tool = TOOLS[name]
      if (!tool) {
        return reply.code(404).send({ ok: false, error: { code: 'unknown_tool', message: `no tool '${name}'` } })
      }
      const parse = tool.schema.safeParse(req.body)
      if (!parse.success) {
        return reply.code(400).send({ ok: false, error: { code: 'invalid_args', message: parse.error.message } })
      }
      const stores = await f.storesFor(hash)
      const jobId = (req.headers['x-matchi-job-id'] as string) ?? randomUUID()
      const ctx = { ...stores, bus: f.bus, jobId }
      try {
        const result = await tool.run(parse.data, ctx)
        return result
      } catch (e) {
        return reply.code(500).send({
          ok: false,
          error: { code: 'tool_threw', message: e instanceof Error ? e.message : String(e) }
        })
      }
    }
  )
}
