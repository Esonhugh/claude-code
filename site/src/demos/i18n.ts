// UI labels come from the real claude web locales so the demo matches the product.
import en from '../../../web/src/locales/en.json'
import zh from '../../../web/src/locales/zh-Hant.json'

export type Lang = 'en' | 'zh'
const tables: Record<Lang, Record<string, string>> = { en, zh }

export function ui(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const raw = tables[lang][key] ?? tables.en[key] ?? key
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
}
