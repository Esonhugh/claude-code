import assert from 'node:assert/strict'
import { mock, test } from 'bun:test'

const fallbackSharp = () => ({ fallback: true })

mock.module('../../utils/bundledMode.js', () => ({
  isInBundledMode: () => true,
  isRunningWithBun: () => true,
}))
mock.module('image-processor-napi', () => ({
  getNativeModule: () => null,
}))
mock.module('sharp', () => ({ default: fallbackSharp }))

let embeddedSharpLoads = 0
globalThis.__CLAUDE_CODE_LOAD_SHARP_NATIVE__ = async () => {
  embeddedSharpLoads += 1
}

test('uses sharp when the bundled native image processor is unavailable', async () => {
  const { getImageProcessor } = await import('./imageProcessor.js')

  assert.equal(await getImageProcessor(), fallbackSharp)
  assert.equal(embeddedSharpLoads, 1)
})
