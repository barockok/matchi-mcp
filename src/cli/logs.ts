import { existsSync, readFileSync, watchFile, unwatchFile, statSync, openSync, readSync, closeSync } from 'node:fs'
import { daemonLogPath } from '../shared/paths'

function tail(path: string, n: number): string[] {
  const content = readFileSync(path, 'utf8')
  const lines = content.split('\n')
  // Drop trailing empty line if present
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n)
}

export async function logs(args: string[]): Promise<number> {
  const follow = args.includes('--follow') || args.includes('-f')
  const path = daemonLogPath()
  if (!existsSync(path)) {
    console.log('logging disabled — set MATCHI_LOG=1 to enable')
    return 0
  }
  for (const line of tail(path, 100)) {
    console.log(line)
  }
  if (!follow) return 0

  // Tail-follow: watch file for size growth and emit new bytes.
  let lastSize = statSync(path).size
  return new Promise<number>((resolve) => {
    watchFile(path, { interval: 500 }, (curr) => {
      if (curr.size < lastSize) {
        // file was truncated/rotated; reset
        lastSize = 0
      }
      if (curr.size > lastSize) {
        const fd = openSync(path, 'r')
        const buf = Buffer.alloc(curr.size - lastSize)
        try {
          readSync(fd, buf, 0, buf.length, lastSize)
          process.stdout.write(buf)
        } finally {
          closeSync(fd)
        }
        lastSize = curr.size
      }
    })
    const cleanup = () => {
      unwatchFile(path)
      resolve(0)
    }
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
  })
}
