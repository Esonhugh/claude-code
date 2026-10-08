import { createContext } from 'react'

/** Actual fullscreen dock host height, after composer and overlays lay out. */
export const ModsPaneHostRowsContext = createContext<number | undefined>(undefined)

/** Fullscreen rows remaining above the composer within its bottom-slot budget. */
export const ModsBandBudgetContext = createContext<number | undefined>(undefined)
