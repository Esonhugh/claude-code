import assert from 'node:assert/strict'
import { afterEach, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerLoopSkill } from './loop.js'

afterEach(() => {
  clearBundledSkills()
})

async function loopPrompt(args: string): Promise<string> {
  clearBundledSkills()
  registerLoopSkill()
  const skill = getBundledSkills().find(command => command.name === 'loop')
  assert.ok(skill && skill.type === 'prompt')
  const blocks = await skill.getPromptForCommand(args, {} as never)
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
}

test('/loop without an interval self-paces with ScheduleWakeup instead of a 10m cron', async () => {
  const prompt = await loopPrompt('check the deploy')
  assert.match(prompt, /3\. \*\*No interval\*\*: otherwise, the entire input is the prompt and you'll self-pace dynamically/)
  assert.match(prompt, /## Dynamic mode \(rule 3 — no interval\)/)
  assert.match(prompt, /call ScheduleWakeup with:/)
  assert.match(prompt, /prefixed with `\/loop ` so the next firing re-enters this skill/)
  assert.match(prompt, /call ScheduleWakeup with `stop: true`/)
  assert.doesNotMatch(prompt, /defaults to 10m|interval is `10m`/)
  assert.match(prompt, /## Input\n\ncheck the deploy$/)
})

test('/loop with an interval still schedules a recurring CronCreate job', async () => {
  const prompt = await loopPrompt('5m /babysit-prs')
  assert.match(prompt, /## Fixed-interval mode \(rules 1 and 2\)/)
  assert.match(prompt, /1\. Call CronCreate with: `cron` \(the expression above\)/)
})

test('/loop with no input shows usage mentioning self-pacing', async () => {
  const prompt = await loopPrompt('   ')
  assert.match(prompt, /^Usage: \/loop \[interval\] <prompt>/)
  assert.match(prompt, /omit the interval\nto let the model self-pace/)
})
