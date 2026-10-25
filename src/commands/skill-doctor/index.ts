import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

const description = 'Show which loaded skills are unused and costing context'

export const skillDoctor: Command = {
  type: 'local-jsx',
  name: 'skill-doctor',
  description,
  immediate: true,
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./skill-doctor.js'),
}

export const skillDoctorNonInteractive: Command = {
  type: 'local',
  name: 'skill-doctor',
  description,
  supportsNonInteractive: true,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./skill-doctor-noninteractive.js'),
}
