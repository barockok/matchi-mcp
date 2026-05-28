import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readDaemonInfoFromFs } from '../mcp/http-client'
import { isDaemonAlive } from '../daemon/lifecycle'
import { matchiHome } from '../shared/paths'

export async function doctor(): Promise<number> {
  const info = readDaemonInfoFromFs()
  let healthy = false
  if (info && isDaemonAlive(info.pid)) {
    try {
      const r = await fetch(`http://127.0.0.1:${info.port}/healthz`)
      healthy = r.ok
    } catch {
      healthy = false
    }
  }
  console.log('matchi doctor')
  console.log('-------------')
  console.log(`MATCHI_HOME: ${matchiHome()}`)
  if (info) {
    const alive = isDaemonAlive(info.pid)
    console.log(`daemon:      pid=${info.pid} port=${info.port} version=${info.version}`)
    console.log(`uptime:      ${Math.floor((Date.now() - info.startedAt) / 1000)}s`)
    console.log(`alive:       ${alive ? 'yes' : 'no (stale pid file)'}`)
    console.log(`healthy:     ${healthy ? 'yes' : 'no'}`)
  } else {
    console.log('daemon:      not running')
  }
  const wsRoot = join(matchiHome(), 'workspaces')
  console.log('workspaces:')
  if (!existsSync(wsRoot)) {
    console.log('  (none)')
  } else {
    const entries = readdirSync(wsRoot).filter((e) => {
      try {
        return statSync(join(wsRoot, e)).isDirectory()
      } catch {
        return false
      }
    })
    if (entries.length === 0) {
      console.log('  (none)')
    } else {
      for (const e of entries) {
        const data = join(wsRoot, e, 'data.duckdb')
        if (existsSync(data)) {
          const st = statSync(data)
          console.log(
            `  ${e}  size=${(st.size / 1024).toFixed(1)}KB  mtime=${st.mtime.toISOString()}`
          )
        } else {
          console.log(`  ${e}  (no data.duckdb)`)
        }
      }
    }
  }
  // Exit 0 when: healthy daemon, OR no daemon at all (clean state).
  // Exit 1 when: daemon info exists but not healthy.
  if (!info) return 0
  return healthy ? 0 : 1
}
