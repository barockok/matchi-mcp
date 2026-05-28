import { z } from 'zod'
import type { Tool } from './types'

export const getExceptionsSchema = z.object({
  match_run_id: z.string(),
  side: z.enum(['a', 'b', 'all']).default('all'),
  page: z.number().int().min(0).default(0),
  page_size: z.number().int().min(1).max(200).default(50),
  description: z.string().optional()
})

export type GetExceptionsArgs = z.infer<typeof getExceptionsSchema>

export interface GetExceptionsData {
  match_run_id: string
  side: 'a' | 'b' | 'all'
  page: number
  page_size: number
  exceptions: Record<string, unknown>[]
  total: number
}

export const getExceptions: Tool<GetExceptionsArgs, GetExceptionsData> = {
  name: 'get_exceptions',
  schema: getExceptionsSchema as unknown as z.ZodType<GetExceptionsArgs>,
  async run(args, ctx) {
    const run = ctx.recon.getRun(args.match_run_id)
    const result = ctx.recon.getMatchResult(args.match_run_id)
    if (!run || !result) {
      return { ok: false, error: { code: 'not_found', message: `match run not found: ${args.match_run_id}` } }
    }

    const upperSide = args.side === 'a' ? 'A' : args.side === 'b' ? 'B' : 'all'
    const offset = args.page * args.page_size
    const exceptions = ctx.recon.getExceptions(args.match_run_id, upperSide as 'A' | 'B' | 'all', args.page_size, offset)

    const total = run.summary
      ? args.side === 'a'
        ? run.summary.unmatchedA
        : args.side === 'b'
          ? run.summary.unmatchedB
          : run.summary.exceptions
      : 0

    return {
      ok: true,
      data: {
        match_run_id: args.match_run_id,
        side: args.side,
        page: args.page,
        page_size: args.page_size,
        exceptions,
        total
      }
    }
  }
}
