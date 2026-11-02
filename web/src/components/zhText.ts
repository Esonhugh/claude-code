import type { Lang } from '../i18n'
import table from './zhText.json'

// The prototype's i18n: zh-Hans text is the source and other languages are
// substring replacements, longest first. zhText.json is the prototype's
// table cut down to the strings the extension dialogs use, plus English for
// the few states the prototype never shows (loading, empty, other hours).
const CJK = /[一-鿿]/
const hantChars = new Map<string, string>()
for (let i = 0; i < table.chars.length; i += 2) hantChars.set(table.chars[i]!, table.chars[i + 1]!)

export function zh(lang: Lang, text: string): string {
  if (lang === 'zh-Hans' || !CJK.test(text)) return text
  let out = text
  for (const [k, v] of (lang === 'en' ? table.en : table.hant) as [string, string][]) {
    if (out.includes(k)) out = out.split(k).join(v)
  }
  return lang === 'zh-Hant' ? out.replace(/[一-鿿]/g, c => hantChars.get(c) ?? c) : out
}

export type Z = (text: string) => string
