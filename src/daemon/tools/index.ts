import { uploadDataset } from './upload-dataset'
import { listSources } from './list-sources'
import { runSql } from './run-sql'
import { runMatch } from './run-match'
import { recallKnownMistakes } from './recall-known-mistakes'
import { saveRecipe } from './save-recipe'
import { listRecipes } from './list-recipes'
import { applyRecipe } from './apply-recipe'
import type { Tool } from './types'

export const TOOLS: Record<string, Tool> = {
  upload_dataset: uploadDataset,
  list_sources: listSources,
  run_sql: runSql,
  run_match: runMatch,
  recall_known_mistakes: recallKnownMistakes,
  save_recipe: saveRecipe,
  list_recipes: listRecipes,
  apply_recipe: applyRecipe
}

export type { Tool, ToolContext } from './types'
