import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getAllOutputStyles,
} from '../../constants/outputStyles.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

const HELP_ARGS = ['help', '-h', '--help']

// Official 2.1.311: no argument lists the styles, a style name saves it to
// local settings.
export const call: LocalCommandCall = async args => {
  const styles = await getAllOutputStyles(getCwd())
  const names = Object.keys(styles)
  const current = getInitialSettings().outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  const typed = args.trim()
  const lower = typed.toLowerCase()
  const match = typed ? names.find(n => n.toLowerCase() === lower) : undefined

  if (match === undefined) {
    if (typed && !HELP_ARGS.includes(lower)) {
      return {
        type: 'text',
        value: `Unknown output style "${typed}". Available styles: ${names.join(', ')}`,
      }
    }
    const rows = names.map(name => {
      const description = styles[name]?.description
      const mark = name === current ? ' (current)' : ''
      return description ? `- ${name}${mark}: ${description}` : `- ${name}${mark}`
    })
    return {
      type: 'text',
      value: `Output style: ${current}\n\nAvailable styles:\n${rows.join('\n')}\n\nUsage: /output-style <style>`,
    }
  }
  if (match === current) {
    return { type: 'text', value: `Output style is already ${match}` }
  }
  const { error } = updateSettingsForSource('localSettings', {
    outputStyle: match,
  })
  if (error) {
    return {
      type: 'text',
      value: `Could not save output style: ${error.message}`,
    }
  }
  return { type: 'text', value: `Output style set to ${match}` }
}
