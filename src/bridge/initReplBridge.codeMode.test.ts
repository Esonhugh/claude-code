import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import {
  codeModeRemoteControlRefusal,
  resetCodeModeGateForTesting,
  settleCodeModeGate,
} from '../tools/REPLTool/codeModeGate.js'
import { initReplBridge } from './initReplBridge.js'

const envKeys = ['CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', 'CLAUDE_CODE_ENTRYPOINT'] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const savedInteractive = getIsInteractive()

beforeEach(() => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  settleCodeModeGate({ remoteControl: false, remote: false })
})

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setIsInteractive(savedInteractive)
  resetCodeModeGateForTesting()
})

describe('initReplBridge in Code Mode', () => {
  test('does not connect and reports the official refusal', async () => {
    const states: Array<[string, string | undefined]> = []
    const handle = await initReplBridge({
      onStateChange: (state, detail) => { states.push([state, detail]) },
    })
    expect(handle).toBeNull()
    expect(states).toEqual([['failed', codeModeRemoteControlRefusal()!]])
  })
})
