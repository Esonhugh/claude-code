export interface Warning {
  message: string
  level?: string
  [key: string]: unknown
}

export interface Workflow {
  name: string
  path: string
  [key: string]: unknown
}

export interface State {
  [key: string]: unknown
}
