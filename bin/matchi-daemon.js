#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildServer } from '../dist/daemon/server.js'
import {
  writeDaemonInfo,
  clearDaemonInfo,
  pickPort,
  startIdleTimer
} from '../dist/daemon/lifecycle.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const idleMs = Number(process.env.MATCHI_IDLE_MS ?? 30 * 60 * 1000)
const port = await pickPort()
const server = await buildServer({ idleTimeoutMs: idleMs })
await server.listen({ port, host: '127.0.0.1' })

writeDaemonInfo({
  pid: process.pid,
  port,
  startedAt: Date.now(),
  version: pkg.version
})

const stop = async (code = 0) => {
  try { await server.close() } catch { /* noop */ }
  clearDaemonInfo()
  process.exit(code)
}
process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(0))
process.on('uncaughtException', (e) => { console.error(e); stop(1) })

startIdleTimer(server.registry, idleMs, () => stop(0))

// Indicate readiness on stdout (parent processes / autospawn waits for /healthz instead)
console.log(JSON.stringify({ pid: process.pid, port, version: pkg.version }))
