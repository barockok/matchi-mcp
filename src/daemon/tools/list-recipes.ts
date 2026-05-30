import { z } from 'zod'
import type { Tool } from './types'
import type { Recipe } from '../stores/recipe-store'

export const listRecipesSchema = z.object({
  description: z.string().optional()
})

export type ListRecipesArgs = z.infer<typeof listRecipesSchema>

export interface ListRecipesEntry {
  name: string
  description: string | null
  source_aliases: string[]
  match_sql: string
  created_at: string
  last_run_at: string | null
  last_match_rate: number | null
  run_count: number
}

export const listRecipes: Tool<ListRecipesArgs, { recipes: ListRecipesEntry[] }> = {
  name: 'list_recipes',
  schema: listRecipesSchema,
  async run(_args, ctx) {
    const rows = (await ctx.recipe.listRecipes()) as Recipe[]
    return {
      ok: true,
      data: {
        recipes: rows.map(r => ({
          name: r.name,
          description: r.description,
          source_aliases: r.sources.map(s => s.alias),
          match_sql: r.match_sql,
          created_at: r.created_at,
          last_run_at: r.last_run_at,
          last_match_rate: r.last_match_rate,
          run_count: r.run_count
        }))
      }
    }
  }
}
