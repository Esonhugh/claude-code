/**
 * With `claudeCode.claudeProcessWrapper` set, the VS Code extension runs
 * `<wrapper> <its bundled claude> <args>`. When the wrapper is this binary,
 * drop that bundled path so subcommands such as `auth status --json` parse.
 */
export function dropProcessWrapperBinaryArg(argv: string[]): string[] {
  const first = argv[2]
  if (first && /[\\/]native-binary[\\/]claude(?:\.exe)?$/.test(first)) {
    return [argv[0]!, argv[1]!, ...argv.slice(3)]
  }
  return argv
}
