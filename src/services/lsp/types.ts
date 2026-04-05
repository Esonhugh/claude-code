export interface ScopedLspServerConfig {
  command: string
  args?: string[]
  rootUri?: string
  languages?: string[]
  [key: string]: unknown
}

export type LspServerState = 'starting' | 'running' | 'stopped' | 'error'
