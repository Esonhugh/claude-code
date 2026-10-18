import { describe, expect, mock, test } from 'bun:test'
import { LspServerConfigSchema } from '../../utils/plugins/schemas.js'
import type { LSPServerInstance } from './LSPServerInstance.js'
import type { LSPServerManager } from './LSPServerManager.js'

// Answers long after the configured requestTimeout.
const sendRequest = mock(
  () => new Promise(resolve => setTimeout(resolve, 1000, 'late')),
)
mock.module('./LSPClient.js', () => ({
  createLSPClient: () => ({
    isInitialized: true,
    start: async () => {},
    initialize: async () => ({ capabilities: {} }),
    sendRequest,
    sendNotification: async () => {},
    onNotification: () => {},
    onRequest: () => {},
    stop: async () => {},
  }),
}))

const { createLSPServerInstance } = await import('./LSPServerInstance.js')
const { registerLSPNotificationHandlers } = await import('./passiveFeedback.js')

const base = {
  command: 'fake-lsp',
  extensionToLanguage: { '.ts': 'typescript' },
}

describe('plugin LSP server options', () => {
  test('accepts requestTimeout and diagnostics', () => {
    const parsed = LspServerConfigSchema().parse({
      ...base,
      requestTimeout: 1500,
      diagnostics: false,
    })
    expect(parsed.requestTimeout).toBe(1500)
    expect(parsed.diagnostics).toBe(false)
    for (const requestTimeout of [0, 2147483648, 1.5]) {
      expect(
        LspServerConfigSchema().safeParse({ ...base, requestTimeout }).success,
      ).toBe(false)
    }
  })

  test('a request answered after requestTimeout fails', async () => {
    const instance = createLSPServerInstance('slow', {
      ...base,
      requestTimeout: 20,
    })
    await instance.start()
    await expect(
      instance.sendRequest('textDocument/hover', {}),
    ).rejects.toThrow("LSP request 'textDocument/hover' failed for server 'slow': no response after 20ms")
  }, 2000)

  test('diagnostics: false keeps publishDiagnostics out of the context', () => {
    const quiet = mock(() => {})
    const loud = mock(() => {})
    const servers = new Map([
      ['quiet', { config: { ...base, diagnostics: false }, onNotification: quiet }],
      ['loud', { config: base, onNotification: loud }],
    ]) as unknown as Map<string, LSPServerInstance>
    const result = registerLSPNotificationHandlers({
      getAllServers: () => servers,
    } as unknown as LSPServerManager)
    expect(quiet).not.toHaveBeenCalled()
    expect(loud).toHaveBeenCalledTimes(1)
    expect(result.registrationErrors).toEqual([])
  })
})
