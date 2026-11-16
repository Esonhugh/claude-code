import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import * as bridgeEnabled from '../bridge/bridgeEnabled.js'
import * as policyLimits from '../services/policyLimits/index.js'
import { resetCodeModeGateForTesting, settleCodeModeGate } from '../tools/REPLTool/codeModeGate.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { renderToString } from './staticRender.js'
import { getActiveNotices, type StatusNoticeContext } from './statusNoticeDefinitions.js'

const envKeys = ['CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', 'CLAUDE_CODE_ENTRYPOINT'] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const savedInteractive = getIsInteractive()
const savedRemoteControlAtStartup = getGlobalConfig().remoteControlAtStartup

function setRemoteControlAtStartup(value: boolean | undefined): void {
  saveGlobalConfig(current => ({ ...current, remoteControlAtStartup: value }))
}

function context(): StatusNoticeContext {
  return { config: getGlobalConfig(), memoryFiles: [] }
}

function codeModeNotices(): string[] {
  return getActiveNotices(context()).map(n => n.id).filter(id => id.startsWith('code-mode-'))
}

async function rendered(id: string): Promise<string> {
  const notice = getActiveNotices(context()).find(n => n.id === id)
  if (!notice) throw new Error(`${id} is not active`)
  return (await renderToString(notice.render(context()), 400)).trim()
}

let bridgeEntitled: ReturnType<typeof spyOn>
let policy: ReturnType<typeof spyOn>

beforeEach(() => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  setRemoteControlAtStartup(true)
  bridgeEntitled = spyOn(bridgeEnabled, 'isBridgeEnabled').mockReturnValue(true)
  policy = spyOn(policyLimits, 'isPolicyAllowed').mockReturnValue(true)
  resetCodeModeGateForTesting()
})

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setIsInteractive(savedInteractive)
  setRemoteControlAtStartup(savedRemoteControlAtStartup)
  bridgeEntitled.mockRestore()
  policy.mockRestore()
  resetCodeModeGateForTesting()
})

describe('Code Mode startup notices (official 2.1.325)', () => {
  test('the remoteControlAtStartup default keeps Code Mode on and warns the session is not connected', async () => {
    settleCodeModeGate({ remoteControl: false, remote: false })
    expect(codeModeNotices()).toEqual(['code-mode-opt-in', 'code-mode-remote-control'])
    expect(await rendered('code-mode-remote-control')).toContain(
      "Remote Control isn't available in Code Mode (experimental) yet, so this session isn't connected. To use Remote Control, quit Claude Code and start it again with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE set to 0.",
    )
  })

  test('--rc refuses Code Mode and shows the unattended refusal instead', async () => {
    settleCodeModeGate({ remoteControl: true, remote: false })
    expect(codeModeNotices()).toEqual(['code-mode-opt-in'])
    expect(await rendered('code-mode-opt-in')).toContain(
      "Code Mode (experimental) isn't available: for now it doesn't work in background jobs, in teammates' panes or with Remote Control. Starting with the ordinary tools.",
    )
  })

  test('the reattach variable refuses Code Mode like --rc', () => {
    process.env.CLAUDE_BRIDGE_REATTACH_SESSION = 'sess'
    try {
      settleCodeModeGate({ remoteControl: false, remote: false })
      expect(codeModeNotices()).toEqual(['code-mode-opt-in'])
    } finally {
      delete process.env.CLAUDE_BRIDGE_REATTACH_SESSION
    }
  })

  test.each([
    ['the default is off', () => setRemoteControlAtStartup(false)],
    ['Remote Control is not available to the account', () => bridgeEntitled.mockReturnValue(false)],
    ['org policy denies Remote Control', () => policy.mockReturnValue(false)],
  ])('no Remote Control notice when %s', (_label, arrange) => {
    arrange()
    settleCodeModeGate({ remoteControl: false, remote: false })
    expect(codeModeNotices()).toEqual(['code-mode-opt-in'])
  })

  test('a Code Mode session says it is on and can be resumed only with Code Mode on', async () => {
    setRemoteControlAtStartup(false)
    settleCodeModeGate({ remoteControl: false, remote: false })
    expect(codeModeNotices()).toEqual(['code-mode-opt-in'])
    expect(await rendered('code-mode-opt-in')).toContain(
      'Code Mode (experimental) is on · this session can be resumed only with Code Mode on',
    )
  })

  test.each([
    ['was not asked for', undefined],
    ['is set to 0', '0'],
  ])('no notice when Code Mode %s', (_label, value) => {
    if (value === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
    else process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = value
    settleCodeModeGate({ remoteControl: true, remote: false })
    expect(codeModeNotices()).toEqual([])
  })

  test('a refused session shows the refusal, not the on notice', async () => {
    settleCodeModeGate({ remoteControl: true, remote: false })
    expect(await rendered('code-mode-opt-in')).not.toContain('is on')
  })

  test('the Code Mode notices come first, as in official', () => {
    settleCodeModeGate({ remoteControl: false, remote: false })
    expect(getActiveNotices(context()).slice(0, 2).map(n => n.id)).toEqual(['code-mode-opt-in', 'code-mode-remote-control'])
  })
})
