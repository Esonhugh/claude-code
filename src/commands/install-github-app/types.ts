export interface Warning {
  title?: string
  message: string
  level?: string
  instructions?: string[]
  [key: string]: unknown
}

export type Workflow =
  | 'claude'
  | 'claude-review'
  | {
      name: string
      path: string
      [key: string]: unknown
    }

export interface State {
  step:
    | 'check-gh'
    | 'warnings'
    | 'choose-repo'
    | 'install-app'
    | 'check-secret'
    | 'check-existing-secret'
    | 'check-existing-workflow'
    | 'select-workflows'
    | 'api-key'
    | 'oauth-flow'
    | 'existing-workflow'
    | 'creating'
    | 'success'
    | 'error'
  selectedRepoName: string
  currentRepo: string
  useCurrentRepo: boolean
  apiKeyOrOAuthToken: string
  useExistingKey: boolean
  currentWorkflowInstallStep: number
  warnings: Warning[]
  secretExists: boolean
  secretName: string
  useExistingSecret: boolean
  workflowExists: boolean
  selectedWorkflows: Workflow[]
  selectedApiKeyOption: 'existing' | 'new' | 'oauth'
  authType: 'api_key' | 'oauth_token'
  workflowAction?: 'update' | 'skip'
  error?: string
  errorReason?: string
  errorInstructions?: string[]
  [key: string]: unknown
}
