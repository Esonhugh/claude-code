import stripAnsi from 'strip-ansi'

// Display only: retain the original path and patch for Git and Ask snapshots.
export function diffDisplayText(text: string): string {
  return stripAnsi(text)
    .replaceAll('\t', '    ')
    .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
}
