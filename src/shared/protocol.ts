export interface DaemonInfo {
  pid: number
  port: number
  startedAt: number
  version: string
}

export interface ToolError {
  code: string
  message: string
  hint?: string
}

export interface ToolEnvelope<T = unknown> {
  ok: true
  data: T
}

export interface ToolErrorEnvelope {
  ok: false
  error: ToolError
}

export type ToolResponse<T = unknown> = ToolEnvelope<T> | ToolErrorEnvelope
