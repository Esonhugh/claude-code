import assert from 'node:assert/strict'

import { reloadSkills } from './reload-skills.js'

let commandMemoClears = 0
let skillClears = 0
let pluginCommandClears = 0
let pluginSkillClears = 0
let pluginRefreshes = 0

const result = reloadSkills({
  clearCommandMemoizationCaches: () => {
    commandMemoClears += 1
  },
  clearSkillCaches: () => {
    skillClears += 1
  },
  clearPluginCommandCache: () => {
    pluginCommandClears += 1
  },
  clearPluginSkillsCache: () => {
    pluginSkillClears += 1
  },
  refreshActivePlugins: () => {
    pluginRefreshes += 1
  },
})

assert.equal(result.message, 'Reloaded skills')
assert.equal(commandMemoClears, 1)
assert.equal(skillClears, 1)
assert.equal(pluginCommandClears, 0)
assert.equal(pluginSkillClears, 0)
assert.equal(pluginRefreshes, 0)

console.log('reload-skills.test.ts passed')
