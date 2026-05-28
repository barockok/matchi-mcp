import { randomUUID } from 'crypto'
import type { Engine } from '../db/engine'

export type ErrorCategory = 'syntax' | 'not_found' | 'validation' | 'other'

export interface ErrorPattern {
  id: string
  tool_name: string
  error_category: ErrorCategory
  latest_error_message: string
  latest_input_summary: string
  correction_input_summary: string | null
  correction_lesson: string | null
  occurrence_count: number
  first_seen_at: string
  last_seen_at: string
}

const MAX_MSG_LEN = 200
const MAX_PROMPT_CHARS = 500
const EXPIRY_DAYS = 30

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

function classifyError(message: string): ErrorCategory {
  if (/SQL syntax error|Parser Error/i.test(message)) return 'syntax'
  if (/does not exist|not found|no such/i.test(message)) return 'not_found'
  if (/disallowed keywords|invalid/i.test(message)) return 'validation'
  return 'other'
}

const esc = (s: string) => s.replace(/'/g, "''")

export class ErrorMemoryStore {
  private initialized = false

  constructor(private readonly engine: Engine) {}

  async init(): Promise<void> {
    if (this.initialized) return
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS error_patterns (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        error_category TEXT NOT NULL,
        latest_error_message TEXT NOT NULL,
        latest_input_summary TEXT NOT NULL,
        correction_input_summary TEXT,
        correction_lesson TEXT,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )
    `)
    this.initialized = true
  }

  async recordError(toolName: string, errorMessage: string, inputSummary: string): Promise<void> {
    await this.init()
    const category = classifyError(errorMessage)
    const msg = truncate(errorMessage, MAX_MSG_LEN)
    const input = truncate(inputSummary, MAX_MSG_LEN)
    const now = new Date().toISOString()

    const existing = await this.engine.query(
      `SELECT id FROM error_patterns WHERE tool_name = '${esc(toolName)}' AND error_category = '${esc(category)}'`
    )

    if (existing.length > 0) {
      await this.engine.execute(
        `UPDATE error_patterns SET occurrence_count = occurrence_count + 1, latest_error_message = '${esc(msg)}', latest_input_summary = '${esc(input)}', last_seen_at = '${now}' WHERE id = '${esc(String(existing[0].id))}'`
      )
    } else {
      const id = randomUUID()
      await this.engine.execute(
        `INSERT INTO error_patterns (id, tool_name, error_category, latest_error_message, latest_input_summary, occurrence_count, first_seen_at, last_seen_at) VALUES ('${esc(id)}', '${esc(toolName)}', '${esc(category)}', '${esc(msg)}', '${esc(input)}', 1, '${now}', '${now}')`
      )
    }
  }

  async recordCorrection(toolName: string, correctionInputSummary: string): Promise<void> {
    await this.init()
    const corrInput = truncate(correctionInputSummary, MAX_MSG_LEN)

    const rows = await this.engine.query(
      `SELECT id, latest_input_summary FROM error_patterns WHERE tool_name = '${esc(toolName)}' AND correction_lesson IS NULL ORDER BY last_seen_at DESC LIMIT 1`
    )
    if (rows.length === 0) return

    const pattern = rows[0]
    const lesson = truncate(`Instead of ${String(pattern.latest_input_summary).slice(0, 60)}, use ${corrInput.slice(0, 60)}`, MAX_MSG_LEN)

    await this.engine.execute(
      `UPDATE error_patterns SET correction_input_summary = '${esc(corrInput)}', correction_lesson = '${esc(lesson)}' WHERE id = '${esc(String(pattern.id))}'`
    )
  }

  async getTopPatterns(limit: number): Promise<ErrorPattern[]> {
    await this.init()
    const rows = await this.engine.query(
      `SELECT * FROM error_patterns ORDER BY occurrence_count DESC, last_seen_at DESC LIMIT ${limit}`
    )
    return rows as unknown as ErrorPattern[]
  }

  async expireOldPatterns(): Promise<void> {
    await this.init()
    const cutoff = new Date(Date.now() - EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
    await this.engine.execute(`DELETE FROM error_patterns WHERE last_seen_at < '${cutoff}'`)
  }

  async buildPromptSection(): Promise<string> {
    await this.expireOldPatterns()
    const patterns = await this.getTopPatterns(10)
    if (patterns.length === 0) return ''

    let section = '\n## Common Mistakes to Avoid\n\nBased on past sessions, avoid these mistakes:\n\n'
    for (const p of patterns) {
      let line = `- [${p.tool_name}] ${p.error_category}: "${p.latest_error_message}"`
      if (p.correction_lesson) {
        line += ` → Fix: ${p.correction_lesson}`
      }
      line += ` (seen ${p.occurrence_count}x)\n`

      if (section.length + line.length > MAX_PROMPT_CHARS) break
      section += line
    }
    return section
  }

  async listAll(): Promise<ErrorPattern[]> {
    await this.init()
    return await this.engine.query(
      `SELECT * FROM error_patterns ORDER BY last_seen_at DESC`
    ) as unknown as ErrorPattern[]
  }

  async deletePattern(id: string): Promise<void> {
    await this.init()
    await this.engine.execute(`DELETE FROM error_patterns WHERE id = '${esc(id)}'`)
  }
}
