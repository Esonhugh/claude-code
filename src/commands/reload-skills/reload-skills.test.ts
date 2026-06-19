import assert from 'node:assert/strict'

import { reloadSkills } from './reload-skills.js'

let commandMemoClears = 0
let skillClears = 0
let pluginCommandClears = 0
let pluginSkillClears = 0
let pluginRefreshes = 0

const result = await reloadSkills({
  clearCommandMemoizationCaches: () => {
    commandMemoClears += 1
  },
  clearSkillCaches: () => {
    skillClears += 1
  },
  loadSkills: () => [
    { name: 'user-one', source: 'userSettings' },
    { name: 'project-one', source: 'projectSettings' },
    { name: 'project-two', source: 'projectSettings' },
  ],
  loadPluginSkills: () => [{ name: 'plugin-one', source: 'plugin' }],
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

assert.equal(result.message, 'Reloaded 4 skills (user 1 skills, project 2 skills, plugin 1 skills)')
assert.equal(commandMemoClears, 1)
assert.equal(skillClears, 1)
assert.equal(pluginCommandClears, 0)
assert.equal(pluginSkillClears, 1)
assert.equal(pluginRefreshes, 0)

console.log('reload-skills.test.ts passed')
