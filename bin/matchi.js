#!/usr/bin/env node
// matchi — MCP stdio server when run with no args; CLI when given a subcommand.
const argv = process.argv.slice(2)
const first = argv[0]
const CLI_COMMANDS = new Set(['doctor', 'start', 'stop', 'logs', 'gc', 'help', '--help', '-h'])
if (first && CLI_COMMANDS.has(first)) {
  await import('../dist/cli/index.js')
} else {
  await import('../dist/mcp/server.js')
}
