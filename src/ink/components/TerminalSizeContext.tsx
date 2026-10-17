import { createContext } from 'react'

export type TerminalSize = {
  columns: number
  rows: number
  global?: { columns: number; rows: number; conversationColumns: number }
}

export const TerminalSizeContext = createContext<TerminalSize | null>(null)
