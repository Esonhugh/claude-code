import { afterEach, expect, test } from 'bun:test'
import { getIsNonInteractiveSession, setIsInteractive } from '../../bootstrap/state.js'
import { findCommand, getCommands } from '../../commands.js'

const wasInteractive = !getIsNonInteractiveSession()

afterEach(() => {
  setIsInteractive(wasInteractive)
})

// Official 2.1.303: `-p "/usage"` (and /cost, /stats) prints the session cost
// as text; interactive sessions open the /usage dialog for /usage and /cost.
test.each(['usage', 'cost', 'stats'])('-p "/%s" resolves to the text command', async name => {
  setIsInteractive(false)
  const command = findCommand(name, await getCommands(process.cwd()))
  expect(command?.type).toBe('local')
  expect(command?.supportsNonInteractive).toBe(true)
})

test.each(['usage', 'cost'])('interactive /%s opens the usage dialog', async name => {
  setIsInteractive(true)
  const command = findCommand(name, await getCommands(process.cwd()))
  expect(command?.type).toBe('local-jsx')
  expect(command?.name).toBe('usage')
})
