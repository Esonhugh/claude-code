import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  formatAdvisorModelName,
  isAdvisorEnabled,
} from '../../utils/advisor.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { ADVISOR_OFF, getAdvisorUsageText, setAdvisor } from './setAdvisor.js'

export const call: LocalCommandCall = async (args, context) => {
  if (!isAdvisorEnabled()) {
    return { type: 'text', value: 'The advisor is not available' }
  }
  const arg = args.trim().toLowerCase()
  if (!arg || COMMON_INFO_ARGS.includes(arg) || COMMON_HELP_ARGS.includes(arg)) {
    const current = context.getAppState().advisorModel
    return {
      type: 'text',
      value: `${current ? `Advisor: ${formatAdvisorModelName(current)}` : 'Advisor: off'}\n${getAdvisorUsageText()}`,
    }
  }
  return {
    type: 'text',
    value: setAdvisor({
      choice: arg === 'unset' ? ADVISOR_OFF : arg,
      mainLoopModel: getMainLoopModel(),
      setAppState: context.setAppState,
      messages: context.messages,
    }),
  }
}
