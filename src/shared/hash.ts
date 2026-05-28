import { createHash } from 'node:crypto'

export function workspaceHash(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}
