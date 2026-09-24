import embeddedRipgrepPath from __CLAUDE_CODE_RIPGREP_BINARY__ with { type: 'file' };
import builtinModsArchivePath from __CLAUDE_CODE_BUILTIN_MODS_ARCHIVE__ with { type: 'file' };

process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_PATH = embeddedRipgrepPath;
process.env.CLAUDE_CODE_EMBEDDED_RIPGREP_VERSION = '__CLAUDE_CODE_RIPGREP_VERSION__';
process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE = builtinModsArchivePath;

await import(__CLAUDE_CODE_EMBEDDED_SHARP__);
await import('./cli.js');
