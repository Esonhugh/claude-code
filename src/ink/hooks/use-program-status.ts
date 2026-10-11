import { useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  CLEAR_ALL_PROGRAM_STATUS,
  programStatus,
  type ProgramStatus,
  wrapForMultiplexer,
} from '../termio/osc.js'
import { getProgramStatusSupport, subscribeProgramStatusSupport } from '../terminal.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

/** Report only after a terminal confirms OSC 7501 support. */
export function useProgramStatus(status: ProgramStatus): void {
  const terminal = useContext(TerminalWriteContext)
  const support = useSyncExternalStore(subscribeProgramStatusSupport, getProgramStatusSupport)
  const sent = useRef(false)
  const sequence = programStatus(status)

  useEffect(() => {
    if (!terminal?.isTTY || support !== 'on') return
    terminal.write(wrapForMultiplexer(sequence))
    sent.current = true
  }, [terminal, sequence, support])

  useEffect(() => {
    if (!terminal?.isTTY) return
    return () => {
      if (!sent.current) return
      sent.current = false
      terminal.write(wrapForMultiplexer(CLEAR_ALL_PROGRAM_STATUS))
    }
  }, [terminal])
}
