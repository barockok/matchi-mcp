import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BIN = resolve(__dirname, '..', '..', 'bin', 'matchi-daemon.js')

describe('matchi-daemon bin', () => {
  let home: string
  let child: ChildProcessWithoutNullStreams
  let info: { pid: number; port: number; version: string }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'matchi-daemon-it-'))
    child = spawn(process.execPath, [BIN], {
      env: { ...process.env, MATCHI_HOME: home, MATCHI_IDLE_MS: '60000' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // Wait for first stdout line containing { pid, port, version }
    const line = await new Promise<string>((resolveLine, reject) => {
      const t = setTimeout(() => reject(new Error('daemon stdout timeout')), 10_000)
      let buf = ''
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString()
        const nl = buf.indexOf('\n')
        if (nl >= 0) { clearTimeout(t); resolveLine(buf.slice(0, nl)) }
      })
      child.on('error', reject)
    })
    info = JSON.parse(line)
    // Poll healthz
    for (let i = 0; i < 20; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${info.port}/healthz`)
        if (r.ok) return
      } catch { /* retry */ }
      await sleep(100)
    }
    throw new Error('daemon did not become healthy')
  }, 15_000)

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await new Promise<void>((r) => child.once('exit', () => r()))
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('writes daemon.json on startup', () => {
    const p = join(home, 'daemon.json')
    expect(existsSync(p)).toBe(true)
    const di = JSON.parse(readFileSync(p, 'utf8'))
    expect(di.pid).toBe(info.pid)
    expect(di.port).toBe(info.port)
  })

  it('clears daemon.json on SIGTERM', async () => {
    child.kill('SIGTERM')
    await new Promise<void>((r) => child.once('exit', () => r()))
    expect(existsSync(join(home, 'daemon.json'))).toBe(false)
  })
})
