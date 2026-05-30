import Fastify, { type FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { WorkspaceRegistry } from './workspace'
import { ReconStore } from './stores/recon-store'
import { RecipeStore } from './stores/recipe-store'
import { ErrorMemoryStore } from './stores/error-memory-store'
import { makeAuthHook } from './auth'
import { healthRoutes } from './routes/health'
import { toolsRoutes } from './routes/tools'

export interface BuildOptions {
  idleTimeoutMs: number
  logger?: boolean
}

export interface MatchiServer extends FastifyInstance {
  registry: WorkspaceRegistry
  matchiVersion: string
  startedAt: number
  storesFor(hash: string): Promise<{
    ws: Awaited<ReturnType<WorkspaceRegistry['touch']>>
    recon: ReconStore
    recipe: RecipeStore
    errorMemory: ErrorMemoryStore
  }>
}

export async function buildServer(opts: BuildOptions): Promise<MatchiServer> {
  const fastify = Fastify({ logger: opts.logger ?? false }) as unknown as MatchiServer
  await fastify.register(sensible)

  const registry = new WorkspaceRegistry({ idleTimeoutMs: opts.idleTimeoutMs })

  let version = '0.0.0'
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', '..', 'package.json')
    version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
  } catch { /* keep default */ }

  fastify.registry = registry
  fastify.matchiVersion = version
  fastify.startedAt = Date.now()

  const storesCache = new Map<string, Awaited<ReturnType<MatchiServer['storesFor']>>>()
  fastify.storesFor = async (hash) => {
    const existing = storesCache.get(hash)
    if (existing) return existing
    const ws = await registry.touch(hash)
    const recon = new ReconStore(ws.meta); await recon.init()
    const recipe = new RecipeStore(ws.meta); await recipe.init()
    const errorMemory = new ErrorMemoryStore(ws.meta); await errorMemory.init()
    const stores = { ws, recon, recipe, errorMemory }
    storesCache.set(hash, stores)
    return stores
  }

  fastify.addHook('preHandler', makeAuthHook(registry))

  await fastify.register(healthRoutes)
  await fastify.register(toolsRoutes, { prefix: '/v1' })

  fastify.addHook('onClose', async () => {
    await registry.closeAll()
    storesCache.clear()
  })

  return fastify
}
