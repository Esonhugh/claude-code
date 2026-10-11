import { useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  CLEAR_ALL_PROGRAM_STATUS,
  clearProgramStatus,
  programStatus,
  programStatusId,
  type ProgramStatus,
  wrapForMultiplexer,
} from '../termio/osc.js'
import { getProgramStatusSupport, subscribeProgramStatusSupport } from '../terminal.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import { logEvent } from '../../services/analytics/index.js'

/** Report changed records only after a terminal confirms OSC 7501 support. */
export function useProgramStatus(
  status: ProgramStatus,
  children: readonly (ProgramStatus & { id: string })[] = [],
  promptMarks = 0,
): void {
  const terminal = useContext(TerminalWriteContext)
  const support = useSyncExternalStore(subscribeProgramStatusSupport, getProgramStatusSupport)
  const sent = useRef(new Map<string, string>())
  const logged = useRef(false)
  const previousMarks = useRef(promptMarks)
  const sequence = programStatus(status)
  // The serialized key is stable across equivalent task objects/rerenders.
  const childKey = JSON.stringify(children.flatMap(child => {
    const id = programStatusId(child.id)
    return id === undefined ? [] : [[id, programStatus({ ...child, id })]]
  }))

  useEffect(() => {
    if (!terminal?.isTTY || support !== 'on') return
    if (previousMarks.current !== promptMarks) {
      previousMarks.current = promptMarks
      sent.current.clear()
    }
    const childSequences = JSON.parse(childKey) as [string, string][]
    const next = new Map<string, string>([['', sequence], ...childSequences])
    let out = ''
    for (const [id, encoded] of next) {
      if (sent.current.get(id) === encoded) continue
      sent.current.set(id, encoded)
      out += encoded
    }
    for (const id of sent.current.keys()) {
      if (next.has(id)) continue
      sent.current.delete(id)
      out += clearProgramStatus(id)
    }
    if (!out) return
    if (!logged.current) {
      logged.current = true
      logEvent('terminal_program_status', {})
    }
    terminal.write(wrapForMultiplexer(out))
  }, [terminal, sequence, childKey, support, promptMarks])

  useEffect(() => {
    if (!terminal?.isTTY) return
    const records = sent.current
    return () => {
      if (records.size === 0) return
      records.clear()
      terminal.write(wrapForMultiplexer(CLEAR_ALL_PROGRAM_STATUS))
    }
  }, [terminal])
}
