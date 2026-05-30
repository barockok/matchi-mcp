import { z } from 'zod'
import type { Tool } from './types'
import { runMatchCore, type RunMatchData } from './run-match'

export const applyRecipeSchema = z.object({
  name: z.string(),
  description: z.string().optional()
})

export type ApplyRecipeArgs = z.infer<typeof applyRecipeSchema>

export const applyRecipe: Tool<ApplyRecipeArgs, RunMatchData> = {
  name: 'apply_recipe',
  schema: applyRecipeSchema,
  async run({ name }, ctx) {
    const recipe = await ctx.recipe.getRecipe(name)
    if (!recipe) {
      return { ok: false, error: { code: 'recipe_not_found', message: `no recipe '${name}'` } }
    }

    const sources = (await ctx.ws.data.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`
    )) as { table_name: string }[]
    const existing = new Set(sources.map(s => s.table_name))
    const missing = recipe.sources.filter(s => !existing.has(s.table)).map(s => s.alias)
    if (missing.length > 0) {
      return {
        ok: false,
        error: {
          code: 'sources_missing',
          message: `recipe needs sources not in workspace: ${missing.join(', ')}`,
          hint: 'upload_dataset(...) for each missing source first'
        }
      }
    }

    const [a, b] = recipe.sources
    const result = await runMatchCore(
      { matched_sql: recipe.match_sql, a: a.table, b: b.table },
      ctx
    )
    if (result.ok) {
      const total = result.data.matched + Math.max(result.data.unmatched_a_total, result.data.unmatched_b_total)
      const matchRate = total > 0 ? result.data.matched / total : 0
      await ctx.recipe.recordRun(name, matchRate)
    }
    return result
  }
}
