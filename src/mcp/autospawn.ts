import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readDaemonInfoFromFs } from './http-client'
import { isDaemonAlive } from '../daemon/lifecycle'
import { workspaceTokenPath } from '../shared/paths'
import type { DaemonInfo } from '../shared/protocol'

const DAEMON_BIN = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/mcp/server.js → <pkg>/bin/matchi-daemon.js
  return resolve(here, '..', '..', 'bin', 'matchi-daemon.js')
})()

async function healthOk(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`)
    return r.ok
  } catch {
    return false
  }
}

export async function ensureDaemon(): Promise<DaemonInfo> {
  let info = readDaemonInfoFromFs()
  if (info && isDaemonAlive(info.pid) && (await healthOk(info.port))) {
    return info
  }
  // Spawn detached
  const child = spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()
  // Poll healthz for up to ~10s
  for (let i = 0; i < 100; i++) {
    await sleep(100)
    info = readDaemonInfoFromFs()
    if (info && (await healthOk(info.port))) return info
  }
  throw new Error('matchi-daemon failed to start within 10s')
}

export async function ensureToken(port: number, hash: string): Promise<void> {
  // The daemon's auth hook calls registry.touch(hash) BEFORE the bearer check,
  // which writes the per-workspace token file. Triggering a probe at any
  // hash-scoped route is enough to materialize the file. We expect a 401.
  if (existsSync(workspaceTokenPath(hash))) return
  try {
    await fetch(`http://127.0.0.1:${port}/v1/workspaces/${hash}/state`, { method: 'GET' })
  } catch {
    /* the probe is expected to 401; even network errors shouldn't block */
  }
  if (!existsSync(workspaceTokenPath(hash))) {
    throw new Error('failed to materialize workspace token after handshake probe')
  }
}
