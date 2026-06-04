import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import type { CustomAgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { SettingSource } from '../../../utils/settings/constants.js'

export interface AgentWizardData {
  name?: string
  description?: string
  prompt?: string
  color?: string
  model?: string
  tools?: string[]
  location?: SettingSource
  method?: string
  agentType?: string
  memory?: string
  generationPrompt?: string
  isGenerating?: boolean
  whenToUse?: string
  systemPrompt?: string
  selectedTools?: string[]
  selectedModel?: string
  selectedColor?: string
  generatedAgent?: unknown
  wasGenerated?: boolean
  finalAgent?: CustomAgentDefinition & {
    color?: AgentColorName
  }
  [key: string]: unknown
}
