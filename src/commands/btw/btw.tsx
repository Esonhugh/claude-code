import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useInterval } from 'usehooks-ts'
import type { CommandResultDisplay } from '../../commands.js'
import { Markdown } from '../../components/Markdown.js'
import { SpinnerGlyph } from '../../components/Spinner/SpinnerGlyph.js'
import { DOWN_ARROW, UP_ARROW } from '../../constants/figures.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CacheSafeParams,
  getLastCacheSafeParams,
} from '../../utils/forkedAgent.js'
import {
  createAssistantMessage,
  createUserMessage,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { runSideQuestion } from '../../utils/sideQuestion.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { truncate } from '../../utils/truncate.js'
import { getSessionId } from '../../bootstrap/state.js'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import { setClipboard } from '../../ink/termio/osc.js'
import { spawnForkFromDirective } from '../../tools/AgentTool/spawnForkFromDirective.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { branchAndResume } from '../branch/branch.js'

type BtwComponentProps = {
  question: string
  context: LocalJSXCommandContext
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type BtwExchange = { question: string; response: string }

const CHROME_ROWS = 5
const OUTER_CHROME_ROWS = 6
const SCROLL_LINES = 3
const HISTORY_SHOWN = 5
const FORK_GLYPH = '\u2442'

// Answered side questions of this session, newest last (2.1.311 btwHistory).
let history: { sessionId: string; exchanges: BtwExchange[] } = {
  sessionId: '',
  exchanges: [],
}
function sessionHistory(): BtwExchange[] {
  if (history.sessionId !== getSessionId()) {
    history = { sessionId: getSessionId(), exchanges: [] }
  }
  return history.exchanges
}

function BtwSideQuestion({
  question,
  context,
  onDone,
}: BtwComponentProps): React.ReactNode {
  const [response, setResponse] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [previous, setPrevious] = useState<BtwExchange[]>(() => [
    ...sessionHistory(),
  ])
  const [browsing, setBrowsing] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [forking, setForking] = useState(false)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const { rows, columns } = useModalOrTerminalSize(useTerminalSize())

  // Animate spinner while loading
  useInterval(() => setFrame(f => f + 1), response || error ? null : 80)
  useInterval(() => setCopied(false), copied ? 2000 : null)

  const shown = previous.slice(-HISTORY_SHOWN)
  const hidden = previous.length - shown.length
  const browsed = browsing === null ? null : (previous[browsing] ?? null)
  const visibleResponse = browsed ? browsed.response : response

  function browse(direction: 'older' | 'newer', wrap = false): void {
    const count = Math.min(previous.length, HISTORY_SHOWN)
    const offset = browsing === null ? 0 : previous.length - browsing
    const step = direction === 'older' ? 1 : -1
    const next = wrap
      ? (offset + step + count + 1) % (count + 1)
      : Math.min(Math.max(offset + step, 0), count)
    if (next === offset) return
    setBrowsing(next === 0 ? null : previous.length - next)
    scrollRef.current?.scrollTo(0)
  }

  function fork(answer: string): void {
    setForking(true)
    const extraMessages = [
      createUserMessage({ content: question }),
      createAssistantMessage({ content: answer }),
    ]
    const reset = (): void => setForking(false)
    if (!isCoordinatorMode()) {
      void spawnForkFromDirective(
        question,
        context,
        context.canUseTool ?? hasPermissionsToUseTool,
        { extraMessages },
      )
        .then(launched => {
          if (launched) {
            onDone(
              `${FORK_GLYPH} forked ${launched.name} (${launched.agentId.slice(-4)})`,
              { display: 'system' },
            )
          } else {
            reset()
            onDone('Cannot fork before the first conversation turn', {
              display: 'system',
            })
          }
        })
        .catch(err => {
          reset()
          onDone(`Failed to fork: ${errorMessage(err)}`)
        })
      return
    }
    void branchAndResume(context, onDone, {
      customTitle: truncate(`btw: ${question}`, 80),
      extraMessages,
    })
      .then(ok => {
        if (!ok) reset()
      })
      .catch(err => {
        reset()
        onDone(`Failed to branch conversation: ${errorMessage(err)}`)
      })
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (forking) {
      e.preventDefault()
      return
    }
    if (
      e.key === 'escape' ||
      e.key === 'return' ||
      e.key === ' ' ||
      (e.ctrl && (e.key === 'c' || e.key === 'd'))
    ) {
      e.preventDefault()
      onDone(undefined, { display: 'skip' })
      return
    }
    if ((e.key === '[' || e.key === ']') && !e.ctrl && !e.meta) {
      e.preventDefault()
      browse(e.key === '[' ? 'older' : 'newer')
      return
    }
    if (e.key === 'tab' && !e.ctrl && !e.meta) {
      e.preventDefault()
      browse(e.shift ? 'newer' : 'older', true)
      return
    }
    if (e.key === 'left' || e.key === 'right') {
      e.preventDefault()
      if (e.shift && !e.ctrl && !e.meta) {
        browse(e.key === 'left' ? 'older' : 'newer')
      }
      return
    }
    if (e.key === 'x' && !e.ctrl && !e.meta && previous.length > 0) {
      e.preventDefault()
      const cleared = new Set(previous)
      history.exchanges = sessionHistory().filter(x => !cleared.has(x))
      setPrevious([])
      setBrowsing(null)
      scrollRef.current?.scrollTo(0)
      return
    }
    if (e.key === 'c' && !e.ctrl && !e.meta && visibleResponse) {
      e.preventDefault()
      void setClipboard(visibleResponse).then(raw => {
        if (raw) process.stdout.write(raw)
      })
      setCopied(true)
      return
    }
    if (
      e.key === 'f' &&
      !e.ctrl &&
      !e.meta &&
      response &&
      browsing === null
    ) {
      e.preventDefault()
      fork(response)
      return
    }
    if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
      e.preventDefault()
      scrollRef.current?.scrollBy(-SCROLL_LINES)
    }
    if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
      e.preventDefault()
      scrollRef.current?.scrollBy(SCROLL_LINES)
    }
  }

  useEffect(() => {
    const abortController = createAbortController()

    async function fetchResponse(): Promise<void> {
      try {
        const cacheSafeParams = await buildCacheSafeParams(context)
        const result = await runSideQuestion({ question, cacheSafeParams })

        if (!abortController.signal.aborted) {
          if (result.response) {
            setResponse(result.response)
            sessionHistory().push({ question, response: result.response })
          } else {
            setError('No response received')
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          setError(errorMessage(err) || 'Failed to get response')
        }
      }
    }

    void fetchResponse()

    return () => {
      abortController.abort()
    }
  }, [question, context])

  const questionWidth = Math.max(20, columns - 7)
  const historyRows = shown.length + (hidden > 0 ? 1 : 0)
  const maxContentHeight = Math.max(
    5,
    rows - CHROME_ROWS - OUTER_CHROME_ROWS - historyRows,
  )

  return (
    <Box
      flexDirection="column"
      paddingLeft={2}
      marginTop={1}
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      {hidden > 0 && <Text dimColor>(+{hidden} earlier /btw)</Text>}
      {shown.map((exchange, i) => {
        const index = hidden + i
        return (
          <Text
            key={index}
            dimColor={browsing !== index}
            bold={browsing === index}
          >
            /btw {truncate(exchange.question, questionWidth)}
          </Text>
        )
      })}
      <Box>
        <Text color={browsed ? undefined : 'warning'} bold={!browsed} dimColor={!!browsed}>
          /btw{' '}
        </Text>
        <Text dimColor>{truncate(question, questionWidth)}</Text>
      </Box>
      <Box marginTop={1} marginLeft={2} maxHeight={maxContentHeight}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {browsed ? (
            <Markdown>{browsed.response}</Markdown>
          ) : error ? (
            <Text color="error">{error}</Text>
          ) : response ? (
            <Markdown>{response}</Markdown>
          ) : (
            <Box>
              <SpinnerGlyph frame={frame} messageColor="warning" />
              <Text color="warning">Answering...</Text>
            </Box>
          )}
        </ScrollBox>
      </Box>
      <Box marginTop={1}>
        {forking ? (
          <Text dimColor>Forking…</Text>
        ) : (
          <Text dimColor>
            <Byline>
              {previous.length > 0 ? (
                <KeyboardShortcutHint shortcut="⇧←/→" action="browse" />
              ) : (
                Boolean(browsed || response || error) && (
                  <KeyboardShortcutHint
                    shortcut={`${UP_ARROW}/${DOWN_ARROW}`}
                    action="scroll"
                  />
                )
              )}
              {Boolean(visibleResponse) &&
                (copied ? (
                  <Text color="success">Copied to clipboard</Text>
                ) : (
                  <KeyboardShortcutHint shortcut="c" action="copy" />
                ))}
              {Boolean(response) && browsing === null && (
                <KeyboardShortcutHint shortcut="f" action="fork" />
              )}
              {previous.length > 0 && (
                <KeyboardShortcutHint shortcut="x" action="clear history" />
              )}
              <KeyboardShortcutHint shortcut="Esc" action="close" />
            </Byline>
          </Text>
        )}
      </Box>
    </Box>
  )
}

/**
 * Build CacheSafeParams for the side question fork.
 *
 * The preferred source is getLastCacheSafeParams — the exact
 * systemPrompt/userContext/systemContext bytes the main thread sent on its
 * last request (captured in stopHooks). Reusing them guarantees a byte-
 * identical prefix and thus a prompt cache hit. We pair these with the
 * current toolUseContext (for thinkingConfig/tools) and current messages
 * (for up-to-date context).
 *
 * Fallback (first turn before stop hooks fire, or prompt-suggestion
 * disabled): rebuild from scratch. This may miss the cache if the main loop
 * applied buildEffectiveSystemPrompt extras (--agent, --system-prompt,
 * --append-system-prompt, coordinator mode).
 */
function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1)
  }
  return messages
}

async function buildCacheSafeParams(
  context: LocalJSXCommandContext,
): Promise<CacheSafeParams> {
  const forkContextMessages = getMessagesAfterCompactBoundary(
    stripInProgressAssistantMessage(context.messages),
  )
  const saved = getLastCacheSafeParams()
  if (saved) {
    return {
      systemPrompt: saved.systemPrompt,
      userContext: saved.userContext,
      resolvedPromptContextBlocks: saved.resolvedPromptContextBlocks,
      systemContext: saved.systemContext,
      toolUseContext: context,
      forkContextMessages,
    }
  }
  const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(
      context.options.tools,
      context.options.mainLoopModel,
      [],
      context.options.mcpClients,
    ),
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt: asSystemPrompt(rawSystemPrompt),
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const question = args?.trim()

  if (!question) {
    onDone('Usage: /btw <your question>', { display: 'system' })
    return null
  }

  saveGlobalConfig(current => ({
    ...current,
    btwUseCount: current.btwUseCount + 1,
  }))

  return (
    <BtwSideQuestion question={question} context={context} onDone={onDone} />
  )
}
