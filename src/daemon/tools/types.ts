import type { z } from 'zod'
import type { Workspace } from '../workspace'
import type { ReconStore } from '../stores/recon-store'
import type { RecipeStore } from '../stores/recipe-store'
import type { ErrorMemoryStore } from '../stores/error-memory-store'
import type { ToolResponse } from '../../shared/protocol'

export interface ToolContext {
  ws: Workspace
  recon: ReconStore
  recipe: RecipeStore
  errorMemory: ErrorMemoryStore
}

export interface Tool<Args = any, Data = any> {
  name: string
  schema: z.ZodType<Args>
  run(args: Args, ctx: ToolContext): Promise<ToolResponse<Data>>
}
