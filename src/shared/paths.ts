import { homedir } from 'node:os'
import { join } from 'node:path'

export function matchiHome(): string {
  return process.env.MATCHI_HOME ?? join(homedir(), '.matchi')
}

export function workspaceDir(hash: string): string {
  return join(matchiHome(), 'workspaces', hash)
}

export function daemonInfoPath(): string {
  return join(matchiHome(), 'daemon.json')
}

export function workspaceTokenPath(hash: string): string {
  return join(workspaceDir(hash), '.token')
}

export function workspaceDuckdbPath(hash: string): string {
  return join(workspaceDir(hash), 'data.duckdb')
}

export function workspaceMetaPath(hash: string): string {
  return join(workspaceDir(hash), 'meta.duckdb')
}

export function daemonLogPath(): string {
  return join(matchiHome(), 'daemon.log')
}
