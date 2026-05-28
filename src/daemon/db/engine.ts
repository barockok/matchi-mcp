import { DuckDBInstance } from '@duckdb/node-api'

export class Engine {
  private instance: DuckDBInstance | null = null
  private connection: any = null

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    if (this.connection) return
    this.instance = await DuckDBInstance.create(this.dbPath)
    this.connection = await this.instance.connect()
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    if (!this.connection) throw new Error('Engine not initialized')
    const reader = await this.connection.runAndReadAll(sql)
    const columns = reader.columnNames()
    const rows = reader.getRows()
    return rows.map((row: unknown[]) => {
      const obj: Record<string, unknown> = {}
      columns.forEach((col: string, i: number) => {
        const val = row[i]
        if (typeof val === 'bigint') {
          obj[col] = (val >= -9007199254740991n && val <= 9007199254740991n)
            ? Number(val)
            : val.toString()
        } else {
          obj[col] = val
        }
      })
      return obj
    })
  }

  async execute(sql: string): Promise<void> {
    if (!this.connection) throw new Error('Engine not initialized')
    await this.connection.run(sql)
  }

  async close(): Promise<void> {
    if (this.connection) {
      try { await this.connection.closeSync?.() } catch { /* noop */ }
      try { await this.connection.disconnectSync?.() } catch { /* noop */ }
      try { await this.connection.close?.() } catch { /* noop */ }
      this.connection = null
    }
    if (this.instance) {
      const inst = this.instance as any
      try { await inst.closeSync?.() } catch { /* noop */ }
      try { await inst.terminateSync?.() } catch { /* noop */ }
      try { await inst.close?.() } catch { /* noop */ }
      this.instance = null
    }
  }
}
