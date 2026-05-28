import { existsSync, readFileSync } from 'node:fs'
import { workspaceTokenPath, daemonInfoPath } from '../shared/paths'
import type { DaemonInfo } from '../shared/protocol'

export class DaemonClient {
  constructor(
    private readonly port: number,
    private readonly hash: string
  ) {}

  private token(): string {
    const p = workspaceTokenPath(this.hash)
    if (!existsSync(p)) throw new Error(`workspace token missing at ${p}`)
    return readFileSync(p, 'utf8').trim()
  }

  async call(toolName: string, args: unknown, jobId?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.token()}`
    }
    if (jobId) headers['x-matchi-job-id'] = jobId
    const r = await fetch(
      `http://127.0.0.1:${this.port}/v1/workspaces/${this.hash}/tools/${toolName}`,
      { method: 'POST', headers, body: JSON.stringify(args ?? {}) }
    )
    return r.json()
  }

  streamUrl(jobId: string): string {
    return `http://127.0.0.1:${this.port}/v1/workspaces/${this.hash}/stream?id=${jobId}`
  }

  bearer(): string {
    return this.token()
  }
}

export function readDaemonInfoFromFs(): DaemonInfo | null {
  const p = daemonInfoPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonInfo
  } catch {
    return null
  }
}
