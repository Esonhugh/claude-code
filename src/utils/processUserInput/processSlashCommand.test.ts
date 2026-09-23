import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearInvokedSkills,
  getInvokedSkillsForAgent,
} from '../../bootstrap/state.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import type { Command } from '../../types/command.js'
import { processSlashCommand } from './processSlashCommand.js'

const promptCommand: Command = {
  type: 'prompt',
  name: 'test-goal-clear',
  description: 'test command',
  progressMessage: 'testing',
  contentLength: 0,
  source: 'builtin',
  hooks: {
    Stop: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'true' }],
      },
    ],
  },
  shouldRegisterHooksForCommand(args): boolean {
    return args.trim() !== 'clear'
  },
  shouldQueryForCommand(args): boolean {
    return args.trim() !== 'clear'
  },
  async getPromptForCommand() {
    return [{ type: 'text', text: 'Goal is clear' }]
  },
}

process.env.ANTHROPIC_API_KEY = 'test-key'

let appState = {
  sessionState: {
    sessionHooks: {},
  },
}

const result = await processSlashCommand(
  '/test-goal-clear clear',
  [],
  [],
  [],
  {
    options: {
      commands: [promptCommand],
      tools: [],
      isNonInteractiveSession: false,
      mcpResources: {},
    },
    messages: [],
    getAppState: () => appState as never,
    setAppState: updater => {
      appState = updater(appState as never) as never
    },
  } as never,
  () => {},
)

assert.equal(result.shouldQuery, false)
assert.equal(result.messages.length, 3)
assert.equal(
  result.messages.some(
    message =>
      message.type === 'attachment' &&
      message.attachment.type === 'command_permissions',
  ),
  false,
)
assert.deepEqual(appState.sessionState.sessionHooks, {})
assert.equal(result.messages[2]?.type, 'system')
assert.equal(
  result.messages[2]?.content,
  '<local-command-stdout>Goal is clear</local-command-stdout>',
)

const originalDisableAttachments = process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const roots: string[] = []
try {
  process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  async function runSkillPrompt(
    handler: string,
    abortController = new AbortController(),
    reuseSnapshot = false,
  ) {
    const root = await mkdtemp(join(tmpdir(), 'mods-skill-prompt-'))
    roots.push(root)
    const entry = join(root, 'register.ts')
    const diagnostics: string[] = []
    const runtime = createModsRuntime({
      onDiagnostic: event => diagnostics.push(`${event.stage}: ${event.message}`),
    })
    runtimes.push(runtime)
    await writeFile(
      entry,
      `export function register(on) {
        on('skill.prompt', { skill: 'rewrite-skill' }, ${handler});
      }`,
    )
    await runtime.reconcile([
      {
        name: 'rewrite-skill',
        storageId: 'rewrite-skill@inline',
        pluginRoot: root,
        entrypoints: [entry],
      },
    ])

    const captures: unknown[] = []
    const releases: number[] = []
    const mods = new Proxy(runtime, {
      get(target, property, receiver) {
        if (property !== 'capture') return Reflect.get(target, property, receiver)
        return (services?: Parameters<typeof runtime.capture>[0]) => {
          const snapshot = runtime.capture(services)
          captures.push(snapshot)
          return {
            ...snapshot,
            release() {
              releases.push(releases.length + 1)
              snapshot.release()
            },
          }
        }
      },
    })
    const rewriteCommand: Command = {
      type: 'prompt',
      name: 'rewrite-skill',
      description: 'rewrite a skill prompt',
      progressMessage: 'loading',
      contentLength: 0,
      source: 'userSettings',
      async getPromptForCommand() {
        return [
          { type: 'text', text: 'Original first block' },
          { type: 'text', text: 'Original second block' },
        ]
      },
    }
    clearInvokedSkills()
    const reusedSnapshot = reuseSnapshot ? mods.capture() : undefined
    try {
      const rewritten = await processSlashCommand(
        '/rewrite-skill',
        [],
        [],
        [],
        {
          options: {
            commands: [rewriteCommand],
            tools: [],
            isNonInteractiveSession: false,
            mcpResources: {},
          },
          messages: [],
          mods,
          modsSnapshot: reusedSnapshot,
          abortController,
          getAppState: () => appState as never,
          setAppState: updater => {
            appState = updater(appState as never) as never
          },
        } as never,
        () => {},
      )
      return { rewritten, captures, releases, diagnostics }
    } finally {
      reusedSnapshot?.release()
    }
  }

  const rewritten = await runSkillPrompt(`async ($, e, next) => {
    const core = await next(e);
    return { text: core.text + '\\n\\nRewritten for the model' };
  }`)
  assert.equal(rewritten.rewritten.shouldQuery, true)
  assert.equal(rewritten.rewritten.messages[1]?.type, 'user')
  assert.deepEqual(
    rewritten.rewritten.messages[1]?.type === 'user'
      ? rewritten.rewritten.messages[1].message.content
      : undefined,
    [
      {
        type: 'text',
        text:
          'Original first block\n\nOriginal second block\n\nRewritten for the model',
      },
    ],
  )
  assert.equal(
    getInvokedSkillsForAgent(null).get(':rewrite-skill')?.content,
    'Original first block\n\nOriginal second block\n\nRewritten for the model',
  )
  assert.equal(rewritten.captures.length, 1)
  assert.equal(rewritten.releases.length, 1)
  assert.deepEqual(rewritten.diagnostics, [])

  const reused = await runSkillPrompt(`async ($, e, next) => {
    const core = await next(e);
    return { text: core.text + '\\n\\nReused snapshot' };
  }`, undefined, true)
  assert.equal(reused.rewritten.messages[1]?.type, 'user')
  assert.match(
    JSON.stringify(
      reused.rewritten.messages[1]?.type === 'user'
        ? reused.rewritten.messages[1].message.content
        : undefined,
    ),
    /Reused snapshot/,
  )
  assert.equal(reused.captures.length, 1)
  assert.equal(reused.releases.length, 1)
  assert.deepEqual(reused.diagnostics, [])

  const failed = await runSkillPrompt(`async ($, e, next) => {
    await next({ skill: 'not-rewrite-skill', text: 'must not reach the model' });
    return { text: 'must not reach the model' };
  }`)
  assert.equal(failed.rewritten.messages[1]?.type, 'user')
  assert.deepEqual(
    failed.rewritten.messages[1]?.type === 'user'
      ? failed.rewritten.messages[1].message.content
      : undefined,
    [
      { type: 'text', text: 'Original first block' },
      { type: 'text', text: 'Original second block' },
    ],
  )
  assert.equal(
    getInvokedSkillsForAgent(null).get(':rewrite-skill')?.content,
    'Original first block\n\nOriginal second block',
  )
  assert.equal(failed.captures.length, 1)
  assert.equal(failed.releases.length, 1)
  assert.equal(failed.diagnostics.length, 1)

  const aborted = new AbortController()
  aborted.abort(new Error('skill prompt cancelled'))
  await assert.rejects(
    runSkillPrompt(`async ($, e, next) => next(e)`, aborted),
    { name: 'AbortError' },
  )
} finally {
  clearInvokedSkills()
  if (originalDisableAttachments === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
  } else {
    process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = originalDisableAttachments
  }
  for (const runtime of runtimes.reverse()) await runtime.dispose()
  for (const root of roots.reverse())
    await rm(root, { recursive: true, force: true })
}

console.log('processSlashCommand.test.ts passed')
