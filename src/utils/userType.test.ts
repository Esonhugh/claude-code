#!/usr/bin/env node
import assert from 'node:assert/strict'

import { isAnt, userType } from './userType.js'

assert.equal(userType(), 'external')
assert.equal(isAnt(), false)

console.log('userType.test.ts passed')
