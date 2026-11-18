import * as React from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Link, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  ADVISOR_MODEL_ALIASES,
  formatAdvisorModelName,
  getAdvisorAliasOptions,
  isValidAdvisorModel,
  modelSupportsAdvisor,
  resolveAdvisorModelId,
} from '../../utils/advisor.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { ADVISOR_OFF, getInvalidAdvisorText, setAdvisor } from './setAdvisor.js'

const ADVISOR_STRATEGY_URL = 'https://claude.com/blog/the-advisor-strategy'

function AdvisorPicker({
  onDone,
  messages,
}: {
  onDone: LocalJSXCommandOnDone
  messages: () => readonly Message[]
}): React.ReactNode {
  const current = useAppState(s => s.advisorModel)
  const mainLoopModel = useMainLoopModel()
  const setAppState = useSetAppState()

  const { options, defaultValue } = React.useMemo(() => {
    const aliases = getAdvisorAliasOptions()
    const lower = current?.toLowerCase()
    const alias = lower ? aliases.find(a => lower.includes(a)) : undefined
    const currentValid =
      current !== undefined && isValidAdvisorModel(resolveAdvisorModelId(current))
    const custom =
      current && !alias && currentValid
        ? { label: formatAdvisorModelName(current), value: current }
        : undefined
    return {
      options: [
        ...aliases.map(a => ({ label: formatAdvisorModelName(a), value: a })),
        ...(custom ? [custom] : []),
        { label: 'No advisor', value: ADVISOR_OFF },
      ],
      defaultValue: currentValid ? (custom?.value ?? alias ?? ADVISOR_OFF) : ADVISOR_OFF,
    }
  }, [current])

  React.useEffect(() => {
    logEvent('tengu_advisor_dialog_shown', {})
  }, [])

  const cancel = () => onDone(undefined, { display: 'skip' })

  return (
    <Dialog title="Advisor (experimental)" onCancel={cancel}>
      <Box flexDirection="column" gap={1}>
        <Text>
          {
            "When Claude needs stronger judgment — a complex decision, an ambiguous failure, a problem it's circling without progress — it escalates to the advisor model for guidance, then resumes. The advisor runs server-side and uses additional tokens."
          }
        </Text>
        {!modelSupportsAdvisor(mainLoopModel) && (
          <Text color="warning">
            The current main model ({formatAdvisorModelName(mainLoopModel)})
            does not support the advisor.
          </Text>
        )}
        <Select
          options={options}
          defaultValue={defaultValue}
          defaultFocusValue={defaultValue}
          onChange={choice =>
            onDone(
              setAdvisor({
                choice,
                mainLoopModel,
                setAppState,
                messages: messages(),
              }),
            )
          }
          onCancel={cancel}
        />
        <Text>
          <Text color="suggestion">Recommended setup: </Text>
          <Text>
            Sonnet as the main model with Opus as the advisor. For certain
            workloads this gives near-Opus performance with reduced token usage.
          </Text>
        </Text>
        <Link url={ADVISOR_STRATEGY_URL} />
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const arg = args.trim().toLowerCase()
  const apply = (choice: string) => {
    onDone(
      setAdvisor({
        choice,
        mainLoopModel: getMainLoopModel(),
        setAppState: context.setAppState,
        messages: context.messages,
      }),
    )
    return null
  }
  if (!arg) {
    return (
      <AdvisorPicker onDone={onDone} messages={() => context.messages} />
    )
  }
  if (arg === ADVISOR_OFF || arg === 'unset') return apply(ADVISOR_OFF)

  const model = resolveAdvisorModelId(arg)
  if (!(ADVISOR_MODEL_ALIASES as readonly string[]).includes(arg)) {
    const { valid, error } = await validateModel(model)
    if (!valid) {
      onDone(`Invalid advisor model: ${error}`)
      return null
    }
  }
  if (!isValidAdvisorModel(model)) {
    onDone(getInvalidAdvisorText(arg))
    return null
  }
  return apply(arg)
}
