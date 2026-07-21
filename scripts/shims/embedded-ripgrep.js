import embeddedRipgrepPath from __CLAUDE_CODE_RIPGREP_BINARY__ with { type: 'file' };

process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH = embeddedRipgrepPath;
process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION = '__CLAUDE_CODE_RIPGREP_VERSION__';

await import('./cli.js');
