import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { workspaceHash } from '../shared/hash'
import { ensureDaemon, ensureToken } from './autospawn'
import { DaemonClient } from './http-client'
import { listMcpTools } from './tools'

export async function main(): Promise<void> {
  const hash = workspaceHash(process.cwd())
  const info = await ensureDaemon()
  await ensureToken(info.port, hash)
  const client = new DaemonClient(info.port, hash)

  const server = new Server(
    { name: 'matchi', version: info.version },
    { capabilities: { tools: {} } }
  )

  const tools = listMcpTools()

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const jobId = randomUUID()
    // TODO: bridge daemon SSE progress events to MCP notifications/progress
    // using `server.notification(...)` keyed by jobId. Out of scope for Task 9.
    const result = await client.call(name, args ?? {}, jobId)
    const isError =
      typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Auto-run when invoked as the entry point. The bundled bin imports this
// module from dist, which triggers this top-level call.
main().catch((err) => {
  console.error('matchi fatal:', err)
  process.exit(1)
})
