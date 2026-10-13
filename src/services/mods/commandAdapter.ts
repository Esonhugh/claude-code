import { isDeepStrictEqual } from 'node:util'
import { getCommandName, type Command, type LocalJSXCommandContext, type LocalJSXCommandOnDone } from '../../types/command.js'
import { isModCommand, type ModCommandDescription } from './commands.js'
import type { ModOrigin } from './types.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import {
  createCommandInputMessage,
  createUserMessage,
  formatCommandInputTags,
} from '../../utils/messages.js'
import type { SlashCommandResult } from '../../utils/processUserInput/processSlashCommand.js'
import type { PromptOrigin } from './promptAdapter.js'
import type { ModSnapshot } from './runtime.js'
import { createToolCatalogForContext } from './toolCatalog.js'
import { createModToolHost } from './toolHost.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { formatPluginDisplayName } from './uiNoticeText.js'

export async function describeModCommand(
  snapshot: ModSnapshot,
  command: Command,
  provider: ModOrigin,
): Promise<ModCommandDescription> {
  const input = {
    command: command.name,
    description: command.description,
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    isHidden: command.isHidden === true,
    immediate: command.immediate === true,
    provider,
  }
  function validateDescription(value: unknown): asserts value is ModCommandDescription {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !('description' in value) || typeof value.description !== 'string' ||
        !('isHidden' in value) || typeof value.isHidden !== 'boolean' ||
        ('argumentHint' in value && value.argumentHint !== undefined && typeof value.argumentHint !== 'string'))
      throw new Error('command.describe requires description, isHidden and an optional string argumentHint')
  }
  return await snapshot.dispatch('command.describe', input, async value => ({
    description: value.description,
    ...(value.argumentHint === undefined ? {} : { argumentHint: value.argumentHint }),
    isHidden: value.isHidden,
  }), {
    callerChain: [],
    validateInput: value => {
      validateDescription(value)
      for (const key of ['command', 'immediate', 'provider'] as const) {
        if (!isDeepStrictEqual(value[key], input[key]))
          throw new Error(`command.describe cannot rewrite ${key}`)
      }
    },
    validateResult: value => {
      validateDescription(value)
      if (Object.keys(value).some(key => !['description', 'argumentHint', 'isHidden'].includes(key)))
        throw new Error('command.describe may only return description, argumentHint and isHidden')
    },
  }) as ModCommandDescription
}

export type CommandPresentation = { isFullscreen: boolean; columns: number }
export type CommandRunInput = {
  command: string
  args: string
  origin: PromptOrigin
  presentation: CommandPresentation
  context?: readonly string[]
}
export type CommandRunResult = { text?: string; ref?: number; context?: readonly string[]; exitCode?:number }

function validateContext(context: unknown): asserts context is readonly string[] | undefined {
  if (context === undefined) return
  if (!Array.isArray(context)) throw new Error('command.run context must be a list of texts')
  for (let index = 0; index < context.length; index++) {
    if (!Object.hasOwn(context, index) || typeof context[index] !== 'string' || context[index] === '')
      throw new Error('command.run context must contain non-empty texts')
  }
}

function retainContext(context: readonly string[] = [], received: readonly string[] = []) {
  const remaining = new Map<string, number>()
  for (const text of context) remaining.set(text, (remaining.get(text) ?? 0) + 1)
  for (const text of received) {
    const count = remaining.get(text) ?? 0
    if (!count) throw new Error('command.run cannot remove received context')
    remaining.set(text, count - 1)
  }
}
export type ModCommandInvocation = {
  snapshot: ModSnapshot
  origin: PromptOrigin
  presentation: CommandPresentation
}

/** Keeps the dialog's mount separate from its asynchronous command completion. */
export async function runImmediateModCommand(
  command: Extract<Command, { type: 'local-jsx' }>,
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const snapshot = !isModCommand(command) && command.userInvocable !== false
    ? context.mods?.capture({
        toolCatalog: () => createToolCatalogForContext(context),
        toolHost: () => createModToolHost(context, context.canUseTool ?? hasPermissionsToUseTool),
      })
    : undefined
  if (!snapshot) return (await command.load()).call(onDone, context, args)

  const ready = Promise.withResolvers<React.ReactNode>()
  let rendered = false
  const signal = context.abortController.signal
  type ImmediateResult = SlashCommandResult & {
    completionOptions?: Parameters<LocalJSXCommandOnDone>[1]
  }
  const pending = new Set<(reason: unknown) => void>()
  const abort = () => {
    for (const reject of pending) reject(signal.reason)
  }
  signal.addEventListener('abort', abort, { once: true })
  void (async () => {
    try {
      const result = await runModCommand({
        snapshot, command, signal,
        input: {
          command: command.name, args,
          origin: context.modCommand?.origin ?? { kind: 'unclassified' },
          presentation: context.modCommand?.presentation ?? {
            columns: process.stdout.columns ?? 80,
            isFullscreen: isFullscreenEnvEnabled(),
          },
        },
        core: rewritten => new Promise<ImmediateResult>((resolve, reject) => {
          signal.throwIfAborted()
          pending.add(reject)
          let done = false
          const complete: LocalJSXCommandOnDone = (text, options) => {
            if (done || signal.aborted) return
            done = true
            pending.delete(reject)
            resolve({ command, messages: [], shouldQuery: false, resultText: text, completionOptions: options })
          }
          void command.load().then(impl => {
            signal.throwIfAborted()
            return impl.call(complete, context, rewritten)
          }).then(jsx => {
            if (!done && !signal.aborted) {
              rendered = true
              ready.resolve(jsx)
            }
          }, error => {
            pending.delete(reject)
            reject(error)
          })
        }),
      }) as ImmediateResult
      const metaMessages = result.messages.flatMap(message =>
        message.type === 'user' && message.isMeta && typeof message.message.content === 'string'
          ? [message.message.content] : [],
      )
      const completion = metaMessages.length ? {
        ...result.completionOptions,
        metaMessages: [...(result.completionOptions?.metaMessages ?? []), ...metaMessages],
      } : result.completionOptions
      onDone(result.resultText, result.commandRunText === undefined ? completion : {
        ...completion, commandRunText: result.commandRunText,
      })
      ready.resolve(null)
    } catch (error) {
      if (signal.aborted) {
        onDone(undefined, { display: 'skip' })
        ready.resolve(null)
      } else if (rendered) {
        onDone(`Error running /${command.name}: ${error instanceof Error ? error.message : String(error)}`, { display: 'system' })
      } else {
        ready.reject(error)
      }
    } finally {
      signal.removeEventListener('abort', abort)
      snapshot.release()
    }
  })()
  return ready.promise
}

/** Wraps the existing slash executor; host results never cross the Mod boundary. */
export async function runModCommand({
  snapshot,
  input,
  command,
  core,
  signal,
}: {
  snapshot: ModSnapshot
  input: CommandRunInput
  command: Command
  core: (args: string) => Promise<SlashCommandResult>
  signal?: AbortSignal
}): Promise<SlashCommandResult> {
  const initial = structuredClone(input)
  if (initial.command !== command.name)
    throw new Error('command.run requires a canonical command name')
  const origin = initial.origin.kind === 'plugin' ? {plugin:initial.origin.name,tier:'user' as const} : undefined
  const matched = snapshot.commandRunHooks?.(initial.command, origin) ?? []
  const runs: SlashCommandResult[] = []
  const pending: Promise<unknown>[] = []
  function validateResult(value: unknown, nextResults: readonly unknown[] = []): asserts value is CommandRunResult {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('command.run must return an object')
    const result = value as CommandRunResult
    validateContext(result.context)
    if (result.exitCode !== undefined && (!Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255)) throw new Error('command.run exitCode must be an integer from 0 to 255')
    for (const below of nextResults as readonly CommandRunResult[]) {
      if (result.ref === undefined || below.ref === result.ref)
        retainContext(result.context, below.context)
    }
    if (result.text !== undefined && typeof result.text !== 'string')
      throw new Error('command.run text must be a string')
    if (
      result.ref !== undefined &&
      (!Number.isSafeInteger(result.ref) ||
        result.ref < 1 ||
        !runs[result.ref - 1])
    )
      throw new Error('command.run ref must identify an execution of this call')
  }
  let result: unknown
  try {
    result = await snapshot.dispatch(
      'command.run',
      structuredClone(initial),
      rewritten => {
        const execution = (async () => {
          signal?.throwIfAborted()
          // Dispatch must enforce these at EVERY next boundary as well, including
          // branches that short-circuit before core; omitted presentation is restored.
          if (rewritten.presentation === undefined)
            rewritten = { ...rewritten, presentation: initial.presentation }
          for (const key of ['command', 'origin', 'presentation'] as const) {
            if (!isDeepStrictEqual(rewritten[key], initial[key]))
              throw new Error(`command.run cannot rewrite ${key}`)
          }
          if (typeof rewritten.args !== 'string')
            throw new Error('command.run args must be a string')
          validateContext(rewritten.context)
          retainContext(rewritten.context, initial.context)
          const context = rewritten.context === undefined ? undefined : [...rewritten.context]
          const host = await core(rewritten.args)
          return { text: host.resultText, ref: runs.push(host), ...(context === undefined ? {} : { context }) }
        })()
        pending.push(execution)
        return execution
      },
      {
        signal,
        ...(initial.origin.kind === 'plugin' ? {origin:{plugin:initial.origin.name,tier:'user' as const}} : {}),
        validateResult,
        restoreResult(result, previous, called) {
          if (called) return result
          const received = previous as CommandRunInput
          const returned = result as CommandRunResult
          retainContext(returned.context, received.context)
          return result
        },
        validateInput(rewritten, received) {
          validateContext(rewritten.context)
          retainContext(rewritten.context, received.context as readonly string[] | undefined)
        },
      },
    )
  } finally {
    await Promise.allSettled(pending)
  }
  signal?.throwIfAborted()
  validateResult(result)
  const host = result.ref === undefined ? runs.at(-1) : runs[result.ref - 1]
  // Official 2.1.292 attributes answers to matching modules, even when a hook
  // short-circuits before the inner modules run. Explicit unchanged refs keep
  // the host's display; author receipts always retain the unprefixed answer.
  const unchanged = result.text === undefined || (result.ref !== undefined && result.text === host?.resultText)
  const displayText = !unchanged && matched.some(hook => hook.tier !== 'builtin')
    ? `${matched.map(hook => formatPluginDisplayName(hook.plugin)).join('+')}: ${result.text}`
    : result.text
  const receipt = displayText === result.text ? {} : {commandRunText:result.text}
  const exitCode = result.exitCode
  if (host) host.commandExitCode = exitCode
  const commandContext = [...(host?.commandContext ?? []),...(result.context ?? [])]
  if (host) host.commandContext = commandContext
  const contextMessages = (result.context ?? []).map(content => createUserMessage({ content, isMeta: true }))
  if (host && (displayText === undefined || displayText === host.resultText))
    return contextMessages.length ? { ...host, messages: [...host.messages, ...contextMessages] } : host
  if (host) {
    const stdout = `<local-command-stdout>${displayText}</local-command-stdout>`
    const isStdout = (text: string) =>
      host.resultText !== undefined &&
      text === `<local-command-stdout>${host.resultText}</local-command-stdout>`
    const index = host.messages.findLastIndex(message => {
      if (message.type === 'system')
        return message.subtype === 'local_command' && isStdout(message.content)
      if (message.type !== 'user' || message.isMeta || message.isCompactSummary)
        return false
      const content = message.message.content
      return typeof content === 'string'
        ? isStdout(content)
        : content.some(block => block.type === 'text' && isStdout(block.text))
    })
    const messages = [...host.messages]
    const message = messages[index]
    if (message?.type === 'system' && message.subtype === 'local_command')
      messages[index] = { ...message, content: stdout }
    else if (message?.type === 'user')
      messages[index] = {
        ...message,
        message: {
          ...message.message,
          content:
            typeof message.message.content === 'string'
              ? stdout
              : message.message.content.map(block =>
                  block.type === 'text' && isStdout(block.text)
                    ? { ...block, text: stdout }
                    : block,
                ),
        },
      }
    else messages.push(createCommandInputMessage(stdout))
    return { ...host, ...receipt, messages: [...messages, ...contextMessages], resultText: displayText }
  }
  return {
    command,
    messages: [
      ...(displayText === undefined
        ? []
        : [
            createCommandInputMessage(
              formatCommandInputTags(
                getCommandName(command),
                command.isSensitive && input.args.trim() ? '***' : input.args,
              ),
            ),
            createCommandInputMessage(
              `<local-command-stdout>${displayText}</local-command-stdout>`,
            ),
          ]),
      ...contextMessages,
    ],
    shouldQuery: false,
    ...(exitCode === undefined ? {} : {commandExitCode:exitCode}),
    resultText: displayText,
    ...receipt,
    commandContext,
  }
}
