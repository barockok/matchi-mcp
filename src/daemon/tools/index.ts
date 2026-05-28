import { runSql } from './run-sql'
import { listSources } from './list-sources'
import { loadSheet } from './load-sheet'
import { runMatch } from './run-match'
import { getExceptions } from './get-exceptions'
import { uploadDataset } from './upload-dataset'
import { recallKnownMistakes } from './recall-known-mistakes'
import type { Tool } from './types'

export const TOOLS: Record<string, Tool> = {
  upload_dataset: uploadDataset,
  list_sources: listSources,
  load_sheet: loadSheet,
  run_sql: runSql,
  run_match: runMatch,
  get_exceptions: getExceptions,
  recall_known_mistakes: recallKnownMistakes
}

export type { Tool, ToolContext } from './types'
