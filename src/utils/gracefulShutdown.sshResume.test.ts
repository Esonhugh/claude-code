import { afterEach, describe, expect, test } from 'bun:test'
import {
  getSSHResumeCommand,
  registerSSHResumeHintContext,
  resetShutdownState,
} from './gracefulShutdown.js'

afterEach(() => {
  resetShutdownState()
})

describe('SSH resume hint context', () => {
  test('quotes the target and remote cwd as shell arguments', () => {
    registerSSHResumeHintContext({
      target: "team host's alias",
      remoteCwd: '/srv/project with spaces',
      remoteSessionId: '11111111-1111-4111-8111-111111111111',
    })

    expect(getSSHResumeCommand()).toBe(
      'claude ssh "team host\'s alias" \'/srv/project with spaces\' --resume 11111111-1111-4111-8111-111111111111',
    )
  })

  test('an older cleanup cannot clear a newer SSH context', () => {
    const clearFirst = registerSSHResumeHintContext({
      target: 'first',
      remoteCwd: '/first',
      remoteSessionId: '11111111-1111-4111-8111-111111111111',
    })
    const clearSecond = registerSSHResumeHintContext({
      target: 'second',
      remoteCwd: '/second',
      remoteSessionId: '22222222-2222-4222-8222-222222222222',
    })

    clearFirst()
    expect(getSSHResumeCommand()).toContain('claude ssh second /second --resume')

    clearSecond()
    expect(getSSHResumeCommand()).toBeNull()
  })
})
