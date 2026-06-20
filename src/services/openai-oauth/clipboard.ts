import { setClipboard as defaultSetClipboard } from '../../ink/termio/osc.js'

type CopyOpenAIAuthUrlOptions = {
  setClipboard?: (text: string) => Promise<string>
  writeStdout?: (text: string) => void
}

export async function copyOpenAIAuthUrlToClipboard(
  url: string,
  opts: CopyOpenAIAuthUrlOptions = {},
): Promise<boolean> {
  try {
    const raw = await (opts.setClipboard ?? defaultSetClipboard)(url)
    if (raw) {
      ;(opts.writeStdout ?? process.stdout.write.bind(process.stdout))(raw)
    }
    return true
  } catch {
    return false
  }
}
