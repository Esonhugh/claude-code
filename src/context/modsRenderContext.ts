import { createContext } from 'react'
import type { ModsRuntime } from '../services/mods/runtime.js'

/** Host state; never exposed to plugin realms or encoded into a UI drawing. */
export const ModsRenderContext = createContext<{ runtime: ModsRuntime; version: number } | undefined>(undefined)
