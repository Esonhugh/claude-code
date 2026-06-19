import assert from 'node:assert/strict'

import { expectColorDiff, expectColorFile, getSyntaxTheme } from './colorDiff.js'

assert.equal(typeof expectColorDiff(), 'function')
assert.equal(typeof expectColorFile(), 'function')
assert.equal(getSyntaxTheme('dark')?.theme, 'Monokai Extended')

console.log('colorDiff.test.ts passed')
