import { readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { matchiHome } from '../shared/paths'
import { readDaemonInfoFromFs } from '../mcp/http-client'
import { isDaemonAlive } from '../daemon/lifecycle'

const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  w: 604_800_000,
  m: 2_592_000_000
}

export function parseDuration(s: string): number {
  const m = /^(\d+)(d|w|m)$/.exec(s)
  if (!m) throw new Error(`bad duration: ${s} (expected e.g. 30d, 2w, 1m)`)
  return Number(m[1]) * UNIT_MS[m[2]]
}

export async function gc(args: string[]): Promise<number> {
  // Refuse if daemon is running
  const info = readDaemonInfoFromFs()
  if (info && isDaemonAlive(info.pid)) {
    console.error('stop the daemon first (matchi stop)')
    return 1
  }

  let thresholdMs = 30 * UNIT_MS.d
  const idx = args.indexOf('--older-than')
  if (idx !== -1) {
    const val = args[idx + 1]
    if (!val) {
      console.error('--older-than requires a value (e.g. 30d, 2w, 1m)')
      return 1
    }
    try {
      thresholdMs = parseDuration(val)
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      return 1
    }
  }

  const wsRoot = join(matchiHome(), 'workspaces')
  if (!existsSync(wsRoot)) {
    console.log('no workspaces')
    return 0
  }
  const cutoff = Date.now() - thresholdMs
  let removed = 0
  for (const e of readdirSync(wsRoot)) {
    const dir = join(wsRoot, e)
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch { continue }
    if (!isDir) continue
    const data = join(dir, 'data.duckdb')
    let mtime = 0
    if (existsSync(data)) {
      mtime = statSync(data).mtimeMs
    } else {
      // No duckdb file — use directory mtime as fallback
      try { mtime = statSync(dir).mtimeMs } catch { continue }
    }
    if (mtime < cutoff) {
      // Safety: never delete the workspaces root or daemon.json
      if (dir === wsRoot || dir === matchiHome()) continue
      rmSync(dir, { recursive: true, force: true })
      console.log(`removed ${e} (mtime=${new Date(mtime).toISOString()})`)
      removed++
    }
  }
  console.log(`gc complete: ${removed} workspace(s) removed`)
  return 0
}
