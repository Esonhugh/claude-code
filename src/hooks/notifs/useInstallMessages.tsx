import { checkInstall } from 'src/utils/nativeInstaller/index.js'
import { logForDebugging } from '../../utils/debug.js'
import { useStartupNotification } from './useStartupNotification.js'

// Like official 2.1.311, install check results go to the debug log (and
// /status, /doctor) instead of the footer, where a long or multi-line
// message crowds out the mode line.
export function useInstallMessages(): void {
  useStartupNotification(async () => {
    const messages = await checkInstall()
    for (const message of messages) {
      logForDebugging(`install check: ${message.message}`, {
        level: message.type === 'error' ? 'error' : 'info',
      })
    }
    return null
  })
}
