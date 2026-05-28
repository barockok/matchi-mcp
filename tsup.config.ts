import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'mcp/server': 'src/mcp/server.ts',
    'daemon/server': 'src/daemon/server.ts',
    'cli/index': 'src/cli/index.ts'
  },
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false
})
