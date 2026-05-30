import { z } from 'zod'
import type { Tool } from './types'

export const saveRecipeSchema = z.object({
  name: z.string().min(1).max(128),
  match_sql: z.string().min(1),
  sources: z
    .array(
      z.object({
        alias: z.string(),
        table: z.string()
      })
    )
    .min(2)
    .max(2),
  description: z.string().optional(),
  overwrite: z.boolean().optional()
})

export type SaveRecipeArgs = z.infer<typeof saveRecipeSchema>

export const saveRecipe: Tool<SaveRecipeArgs, { name: string }> = {
  name: 'save_recipe',
  schema: saveRecipeSchema,
  async run({ name, match_sql, sources, description, overwrite }, ctx) {
    const existing = await ctx.recipe.getRecipe(name)
    if (existing && !overwrite) {
      return {
        ok: false,
        error: {
          code: 'recipe_exists',
          message: `recipe '${name}' already exists; pass overwrite:true or delete it first`
        }
      }
    }
    if (existing) await ctx.recipe.deleteRecipe(name)
    await ctx.recipe.addRecipe({ name, match_sql, sources, description: description ?? null })
    return { ok: true, data: { name } }
  }
}
