import { spawnSync } from 'node:child_process';
import embeddedRipgrepPath from __CLAUDE_CODE_RIPGREP_BINARY__ with { type: 'file' };
import { getEmbeddedRipgrepPath } from '../src/utils/embeddedRipgrep.ts';

process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH = embeddedRipgrepPath;
process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION = '__CLAUDE_CODE_RIPGREP_VERSION__';

if (process.env.CLAUDE_CODE_VERIFY_EMBEDDED_RIPGREP === '1') {
  const ripgrepPath = getEmbeddedRipgrepPath();
  if (!ripgrepPath) throw new Error('Embedded ripgrep is unavailable');
  const result = spawnSync(ripgrepPath, ['--version'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

await import('./cli.js');
