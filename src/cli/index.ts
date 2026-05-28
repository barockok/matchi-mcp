import { doctor } from './doctor'
import { start } from './start'
import { stop } from './stop'
import { logs } from './logs'
import { gc } from './gc'

function printHelp(): void {
  console.log(`matchi — local reconciliation daemon

Usage:
  matchi <command> [options]

Commands:
  doctor              Show daemon status, workspaces, and health.
  start               Start the matchi-daemon (no-op if already running).
  stop                Gracefully stop the daemon.
  logs [-f|--follow]  Print recent daemon logs.
  gc [--older-than D] Remove workspaces older than D (default 30d). Units: d|w|m.
  help                Show this message.
`)
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'doctor':
      return await doctor()
    case 'start':
      return await start()
    case 'stop':
      return await stop()
    case 'logs':
      return await logs(rest)
    case 'gc':
      return await gc(rest)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      return 0
    default:
      console.error(`unknown command: ${cmd}`)
      printHelp()
      return 1
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
