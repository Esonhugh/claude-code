import type { Register } from 'claude-code'

export const register: Register = on => {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (String(e.file_path).endsWith('.env')) return { deny: 'hello-mod: .env files are off limits' }
    return next(e)
  })
}
