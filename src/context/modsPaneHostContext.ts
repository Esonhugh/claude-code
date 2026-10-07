import { createContext } from 'react'

/** Actual fullscreen dock host height, after composer and overlays lay out. */
export const ModsPaneHostRowsContext = createContext<number | undefined>(undefined)
