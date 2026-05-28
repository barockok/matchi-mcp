import { setTimeout as sleep } from 'node:timers/promises'
import { existsSync, unlinkSync } from 'node:fs'
import { readDaemonInfoFromFs } from '../mcp/http-client'
import { isDaemonAlive } from '../daemon/lifecycle'
import { daemonInfoPath } from '../shared/paths'

export async function stop(): Promise<number> {
  const info = readDaemonInfoFromFs()
  if (!info) {
    console.log('not running')
    return 0
  }
  if (!isDaemonAlive(info.pid)) {
    // Stale pid file
    try { unlinkSync(daemonInfoPath()) } catch { /* noop */ }
    console.log('not running (cleared stale pid file)')
    return 0
  }
  try {
    await fetch(`http://127.0.0.1:${info.port}/v1/shutdown`, { method: 'POST' })
  } catch {
    // daemon may already be going down; fall through to wait
  }
  const p = daemonInfoPath()
  for (let i = 0; i < 50; i++) {
    const fileGone = !existsSync(p)
    const procGone = !isDaemonAlive(info.pid)
    if (fileGone || procGone) {
      // Clean up stale info file if process is gone but file wasn't cleared
      // (the /v1/shutdown route exits via process.exit which skips signal handlers).
      if (!fileGone && procGone) {
        try { unlinkSync(p) } catch { /* noop */ }
      }
      console.log(`stopped (pid=${info.pid})`)
      return 0
    }
    await sleep(100)
  }
  console.error('daemon did not shut down within 5s')
  return 1
}
