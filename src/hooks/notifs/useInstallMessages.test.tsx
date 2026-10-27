import { expect, mock, test } from 'bun:test'

let compute: (() => unknown) | undefined
mock.module('./useStartupNotification.js', () => ({
  useStartupNotification: (fn: () => unknown) => {
    compute = fn
  },
}))
mock.module('src/utils/nativeInstaller/index.js', () => ({
  checkInstall: async () => [
    {
      message: 'Native installation exists but ~/.local/bin is not in your PATH. Run:\n\necho ...',
      userActionRequired: true,
      type: 'path',
    },
    { message: 'installMethod is native, but directory /x does not exist', userActionRequired: true, type: 'error' },
  ],
}))

const { useInstallMessages } = await import('./useInstallMessages.js')

test('install check results do not become footer notifications', async () => {
  useInstallMessages()
  expect(compute).toBeDefined()
  expect(await compute!()).toBeNull()
})
