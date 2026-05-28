import { ensureDaemon } from '../mcp/autospawn'

export async function start(): Promise<number> {
  try {
    const info = await ensureDaemon()
    console.log(`daemon running: pid=${info.pid} port=${info.port} version=${info.version}`)
    return 0
  } catch (e) {
    console.error(`failed to start daemon: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
