export interface SourceInfo {
  table: string
  alias: string | null
  rows: number
  columns: { name: string; type: string }[]
  uploaded_at: number
}
