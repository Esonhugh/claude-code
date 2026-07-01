import assert from 'node:assert/strict';
import { getEnabledFeatures, macroValues } from './build.mjs';
import { feature } from './shims/bun-bundle.js';

assert.equal(getEnabledFeatures('').has('AGENT_TRIGGERS'), true);
assert.equal(getEnabledFeatures(undefined).has('AGENT_TRIGGERS'), true);
assert.equal(getEnabledFeatures('WORKFLOW_SCRIPTS').has('AGENT_TRIGGERS'), true);
assert.equal(getEnabledFeatures('WORKFLOW_SCRIPTS').has('WORKFLOW_SCRIPTS'), true);
assert.equal(feature('AGENT_TRIGGERS'), true);
assert.equal(macroValues['MACRO.PACKAGE_URL'], JSON.stringify('@esonhugh/claude-code'));

console.log('build.test.mjs passed');
