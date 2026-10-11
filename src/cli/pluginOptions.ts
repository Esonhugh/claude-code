import { Option } from '@commander-js/extra-typings'

export function createPluginDirNoMcpOption() {
  return new Option(
    '--plugin-dir-no-mcp <path>',
    "Like --plugin-dir but the engine will not read this plugin's .mcp.json (caller owns its MCP connections)",
  )
    .argParser((path: string, paths: string[]) => [...paths, path])
    .default([] as string[])
    .hideHelp()
}
