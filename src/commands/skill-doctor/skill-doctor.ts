import type { LocalJSXCommandCall } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { buildSkillDoctorReport } from './skillDoctor.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  try {
    onDone(await buildSkillDoctorReport(context), { display: 'system' })
  } catch (error) {
    logError(error)
    onDone(
      `Couldn't compute skill usage. Run with --debug for details. (${errorMessage(error)})`,
      { display: 'system' },
    )
  }
  return null
}
