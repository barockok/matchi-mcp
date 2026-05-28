import { EventEmitter } from 'node:events'

export type ProgressEvent = { phase: string; payload?: unknown; ts: number }

export class ProgressBus extends EventEmitter {
  emitProgress(jobId: string, phase: string, payload?: unknown): void {
    this.emit(`job:${jobId}`, { phase, payload, ts: Date.now() } satisfies ProgressEvent)
  }
  subscribe(jobId: string, cb: (e: ProgressEvent) => void): () => void {
    const handler = (e: ProgressEvent) => cb(e)
    this.on(`job:${jobId}`, handler)
    return () => this.off(`job:${jobId}`, handler)
  }
}
