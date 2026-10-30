import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    await $.command.register({ name: 'hello-mod', description: 'Show a greeting', immediate: true })
    return next(event)
  })
  on('command.run', { command: 'hello-mod' }, () => ({ text: 'Hello from my first mod' }))
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (String(e.file_path).endsWith('.env')) return { deny: 'hello-mod: .env files are off limits' }
    return next(e)
  })
}
