import type { FastifyRequest, FastifyReply } from 'fastify'
import type { WorkspaceRegistry } from './workspace'

export function makeAuthHook(registry: WorkspaceRegistry) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { hash?: string }
    const hash = params.hash
    if (!hash) return
    // Touch BEFORE bearer check so the workspace dir + token file are created
    // on first contact. The MCP shim relies on this to bootstrap its bearer by
    // reading the token from disk after an unauthenticated probe.
    await registry.touch(hash)
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: 'missing bearer' } })
    }
    const token = auth.slice(7)
    if (!registry.verifyToken(hash, token)) {
      return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: 'bad token' } })
    }
  }
}
