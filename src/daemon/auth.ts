import type { FastifyRequest, FastifyReply } from 'fastify'
import type { WorkspaceRegistry } from './workspace'

export function makeAuthHook(registry: WorkspaceRegistry) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { hash?: string }
    const hash = params.hash
    if (!hash) return
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: 'missing bearer' } })
    }
    const token = auth.slice(7)
    await registry.touch(hash)
    if (!registry.verifyToken(hash, token)) {
      return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: 'bad token' } })
    }
  }
}
