export interface AgentWizardData {
  name?: string
  description?: string
  prompt?: string
  color?: string
  model?: string
  tools?: string[]
  location?: string
  method?: string
  agentType?: string
  memory?: string
  [key: string]: unknown
}
