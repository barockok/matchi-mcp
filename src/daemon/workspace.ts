import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { workspaceDir, workspaceTokenPath, workspaceDuckdbPath, workspaceMetaPath } from '../shared/paths'
import { Engine } from './db/engine'

export interface Workspace {
  hash: string
  token: string
  dir: string
  data: Engine
  meta: Engine
  lastActivity: number
}

export interface RegistryOptions {
  idleTimeoutMs: number
}

export class WorkspaceRegistry {
  private workspaces = new Map<string, Workspace>()
  constructor(private readonly opts: RegistryOptions) {}

  async touch(hash: string): Promise<Workspace> {
    const cached = this.workspaces.get(hash)
    if (cached) {
      cached.lastActivity = Date.now()
      return cached
    }
    const dir = workspaceDir(hash)
    mkdirSync(dir, { recursive: true })
    const tokPath = workspaceTokenPath(hash)
    let token: string
    if (existsSync(tokPath)) {
      token = readFileSync(tokPath, 'utf8').trim()
    } else {
      token = randomBytes(32).toString('hex')
      writeFileSync(tokPath, token, { mode: 0o600 })
      chmodSync(tokPath, 0o600)
    }
    const data = new Engine(workspaceDuckdbPath(hash))
    const meta = new Engine(workspaceMetaPath(hash))
    await data.init()
    await meta.init()
    const ws: Workspace = { hash, token, dir, data, meta, lastActivity: Date.now() }
    this.workspaces.set(hash, ws)
    return ws
  }

  verifyToken(hash: string, token: string): boolean {
    const ws = this.workspaces.get(hash)
    if (!ws) return false
    return ws.token === token
  }

  list(): Workspace[] {
    return [...this.workspaces.values()]
  }

  async closeAll(): Promise<void> {
    for (const ws of this.workspaces.values()) {
      await ws.data.close()
      await ws.meta.close()
    }
    this.workspaces.clear()
  }

  msSinceLastActivity(): number {
    if (this.workspaces.size === 0) return Infinity
    const newest = Math.max(...[...this.workspaces.values()].map(w => w.lastActivity))
    return Date.now() - newest
  }
}
