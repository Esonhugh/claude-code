import type { LocalCommandCall } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { buildSkillDoctorReport } from './skillDoctor.js'

export const call: LocalCommandCall = async (_args, context) => {
  try {
    return { type: 'text', value: await buildSkillDoctorReport(context) }
  } catch (error) {
    logError(error)
    return {
      type: 'text',
      value: `Couldn't compute skill usage. Run with --debug for details. (${errorMessage(error)})`,
    }
  }
}
