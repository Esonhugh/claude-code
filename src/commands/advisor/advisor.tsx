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
  formatAdvisorModelName,
  isValidAdvisorModel,
  resolveAdvisorModelId,
} from '../../utils/advisor.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { validateModel } from '../../utils/model/validateModel.js'
import {
  ADVISOR_OFF,
  getAdvisorModelOptions,
  getInvalidAdvisorText,
  setAdvisor,
  toAdvisorChoice,
} from './setAdvisor.js'

const ADVISOR_STRATEGY_URL = 'https://claude.com/blog/the-advisor-strategy'
const MAX_VISIBLE_OPTIONS = 10

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

  // The same candidates as /model, plus the current advisor if it is not one.
  const { options, defaultValue } = React.useMemo(() => {
    const models = getAdvisorModelOptions()
    const valid =
      current !== undefined && isValidAdvisorModel(resolveAdvisorModelId(current))
        ? current
        : undefined
    const custom =
      valid !== undefined && !models.some(model => model.value === valid)
        ? [{ label: formatAdvisorModelName(valid), value: valid }]
        : []
    return {
      options: [...models, ...custom, { label: 'No advisor', value: ADVISOR_OFF }],
      defaultValue: valid ?? ADVISOR_OFF,
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
            "When Claude needs stronger judgment — a complex decision, an ambiguous failure, a problem it's circling without progress — it escalates to the advisor model for guidance, then resumes. The advisor uses additional tokens."
          }
        </Text>
        <Select
          options={options}
          visibleOptionCount={Math.min(MAX_VISIBLE_OPTIONS, options.length)}
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
  const typed = args.trim()
  const arg = typed.toLowerCase()
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

  const choice = toAdvisorChoice(typed)
  const model = resolveAdvisorModelId(choice)
  if (!isValidAdvisorModel(model)) {
    onDone(getInvalidAdvisorText(choice))
    return null
  }
  // Like /model: an alias or a listed model is taken as it is; any other
  // name is checked against the endpoint first.
  const known =
    isModelAlias(choice) ||
    getAdvisorModelOptions().some(option => option.value === choice)
  if (!known) {
    const { valid, error } = await validateModel(model)
    if (!valid) {
      onDone(`Invalid advisor model: ${error}`)
      return null
    }
  }
  return apply(choice)
}
