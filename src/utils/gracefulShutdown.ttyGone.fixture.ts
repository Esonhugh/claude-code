// Runs gracefulShutdown after the terminal is gone (stdout closed) while a
// session-end memory extraction is pending. Cleanup must still run.
import { mock } from 'bun:test'
import { closeSync, writeFileSync } from 'fs'

const extractPath = new URL('../services/extractMemories/extractMemories.ts', import.meta.url).pathname
const extract = await import(extractPath)
mock.module(extractPath, () => ({
  ...extract,
  hasDeferredExtraction: () => true,
  flushDeferredExtraction: async () => {},
}))
const { registerCleanup } = await import('./cleanupRegistry.js')
const { gracefulShutdown } = await import('./gracefulShutdown.js')
registerCleanup(async () => {
  writeFileSync(process.argv[2]!, 'cleaned')
})
closeSync(1)
await gracefulShutdown(129)
