import { z } from 'zod'
import type { Tool } from './types'
import type { ErrorPattern } from '../stores/error-memory-store'

export const recallKnownMistakesSchema = z.object({}).strict()
export type RecallKnownMistakesArgs = z.infer<typeof recallKnownMistakesSchema>

export const recallKnownMistakes: Tool<RecallKnownMistakesArgs, { patterns: ErrorPattern[] }> = {
  name: 'recall_known_mistakes',
  schema: recallKnownMistakesSchema,
  async run(_args, ctx) {
    const patterns = await ctx.errorMemory.getTopPatterns(10)
    return { ok: true, data: { patterns } }
  }
}
