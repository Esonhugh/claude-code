import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

test('interactive cc:// forwards --permission-mode to the remote session', () => {
  expect(source).toMatch(
    /createDirectConnectSession\(\{\s*serverUrl: _pendingConnect\.url,[\s\S]{0,300}permissionMode: permissionModeCli,/,
  )
})
