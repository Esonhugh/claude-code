import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { Tool } from '../../Tool.js'

export interface PluginSettingsProps {
  onComplete: (result?: string) => void
  args?: string
  showMcpRedirectMessage?: boolean
}

export type ViewState =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'add-marketplace'; initialValue?: string }
  | { type: 'marketplace-menu' }
  | { type: 'marketplace-list' }
  | { type: 'validate'; path?: string }
  | { type: 'discover-plugins'; targetPlugin?: string }
  | { type: 'browse-marketplace'; targetMarketplace?: string; targetPlugin?: string }
  | {
      type: 'manage-marketplaces'
      targetMarketplace?: string
      action?: 'update' | 'remove'
    }
  | {
      type: 'manage-plugins'
      targetPlugin?: string
      targetMarketplace?: string
      action?: 'enable' | 'disable' | 'uninstall'
    }
  | { type: 'plugin-options' }
  | { type: 'confirm-data-cleanup'; size: { bytes: number; human: string } }
  | { type: 'mcp-detail'; client: MCPServerConnection }
  | { type: 'mcp-tools'; client: MCPServerConnection }
  | { type: 'mcp-tool-detail'; client: MCPServerConnection; tool: Tool }

export type ParentViewState = ViewState
