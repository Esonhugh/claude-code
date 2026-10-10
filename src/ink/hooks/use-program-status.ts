import { useContext, useEffect } from 'react'
import {
  CLEAR_PROGRAM_STATUS,
  programStatus,
  type ProgramStatus,
  wrapForMultiplexer,
} from '../termio/osc.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

/** OSC 7501 detection is optional; unsupported terminals ignore reports. */
export function useProgramStatus(status: ProgramStatus): void {
  const terminal = useContext(TerminalWriteContext)
  const sequence = programStatus(status)

  useEffect(() => {
    if (terminal?.isTTY) terminal.write(wrapForMultiplexer(sequence))
  }, [terminal, sequence])

  useEffect(() => {
    if (!terminal?.isTTY) return
    return () => terminal.write(wrapForMultiplexer(CLEAR_PROGRAM_STATUS))
  }, [terminal])
}
