import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer } from 'node:net'
import { daemonInfoPath, matchiHome } from '../shared/paths'
import type { DaemonInfo } from '../shared/protocol'
import type { WorkspaceRegistry } from './workspace'

export function writeDaemonInfo(info: DaemonInfo): void {
  const p = daemonInfoPath()
  mkdirSync(dirname(p), { recursive: true })
  // ensure matchi home exists too
  mkdirSync(matchiHome(), { recursive: true })
  writeFileSync(p, JSON.stringify(info, null, 2))
}

export function readDaemonInfo(): DaemonInfo | null {
  const p = daemonInfoPath()
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as DaemonInfo }
  catch { return null }
}

export function clearDaemonInfo(): void {
  const p = daemonInfoPath()
  if (existsSync(p)) unlinkSync(p)
}

export function isDaemonAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

export function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('no port')))
      }
    })
  })
}

export function startIdleTimer(registry: WorkspaceRegistry, idleMs: number, onIdle: () => void): NodeJS.Timeout {
  const check = () => {
    if (registry.msSinceLastActivity() > idleMs) onIdle()
  }
  const handle = setInterval(check, Math.min(60_000, idleMs))
  handle.unref()
  return handle
}
