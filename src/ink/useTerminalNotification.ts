import { createContext, useCallback, useContext, useMemo } from 'react'
import { isProgressReportingAvailable, type Progress } from './terminal.js'
import { BEL } from './termio/ansi.js'
import { ITERM2, OSC, osc, PROGRESS, wrapForMultiplexer } from './termio/osc.js'

export type TerminalWriter = {
  write(data: string): void
  isTTY: boolean
}

export const TerminalWriteContext = createContext<TerminalWriter | null>(null)

export const TerminalWriteProvider = TerminalWriteContext.Provider

export type TerminalNotification = {
  notifyITerm2: (opts: { message: string; title?: string }) => void
  notifyKitty: (opts: { message: string; title: string; id: number }) => void
  notifyGhostty: (opts: { message: string; title: string }) => void
  notifyBell: () => void
  /**
   * Report progress to the terminal via OSC 9;4 sequences.
   * Supported terminals: ConEmu, Ghostty 1.2.0+, iTerm2 3.6.6+
   * Pass state=null to clear progress.
   */
  progress: (state: Progress['state'] | null, percentage?: number) => void
}

export function useTerminalNotification(): TerminalNotification {
  const terminal = useContext(TerminalWriteContext)
  if (!terminal) {
    throw new Error(
      'useTerminalNotification must be used within TerminalWriteProvider',
    )
  }

  const notifyITerm2 = useCallback(
    ({ message, title }: { message: string; title?: string }) => {
      const displayString = title ? `${title}:\n${message}` : message
      terminal.write(wrapForMultiplexer(osc(OSC.ITERM2, `\n\n${displayString}`)))
    },
    [terminal],
  )

  const notifyKitty = useCallback(
    ({
      message,
      title,
      id,
    }: {
      message: string
      title: string
      id: number
    }) => {
      terminal.write(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=0:p=title`, title)))
      terminal.write(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:p=body`, message)))
      terminal.write(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=1:a=focus`, '')))
    },
    [terminal],
  )

  const notifyGhostty = useCallback(
    ({ message, title }: { message: string; title: string }) => {
      terminal.write(wrapForMultiplexer(osc(OSC.GHOSTTY, 'notify', title, message)))
    },
    [terminal],
  )

  const notifyBell = useCallback(() => {
    // Raw BEL — inside tmux this triggers tmux's bell-action (window flag).
    // Wrapping would make it opaque DCS payload and lose that fallback.
    terminal.write(BEL)
  }, [terminal])

  const progress = useCallback(
    (state: Progress['state'] | null, percentage?: number) => {
      if (!isProgressReportingAvailable()) {
        return
      }
      if (!state) {
        terminal.write(
          wrapForMultiplexer(
            osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, ''),
          ),
        )
        return
      }
      const pct = Math.max(0, Math.min(100, Math.round(percentage ?? 0)))
      switch (state) {
        case 'completed':
          terminal.write(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, ''),
            ),
          )
          break
        case 'error':
          terminal.write(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.ERROR, pct),
            ),
          )
          break
        case 'indeterminate':
          terminal.write(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.INDETERMINATE, ''),
            ),
          )
          break
        case 'running':
          terminal.write(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.SET, pct),
            ),
          )
          break
        case null:
          // Handled by the if guard above
          break
      }
    },
    [terminal],
  )

  return useMemo(
    () => ({ notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress }),
    [notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress],
  )
}
