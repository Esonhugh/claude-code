import en from './locales/en.json'
import zhHans from './locales/zh-Hans.json'
import zhHant from './locales/zh-Hant.json'

export type Lang = 'zh-Hans' | 'zh-Hant' | 'en'
export type MessageKey = keyof typeof en

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh-Hans', label: '简体中文' },
  { id: 'zh-Hant', label: '繁體中文' },
  { id: 'en', label: 'English' },
]

const messages: Record<Lang, Partial<Record<MessageKey, string>>> = {
  en,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
}

const STORAGE_KEY = 'claude-web-lang'

export function detectLang(languages: readonly string[]): Lang {
  for (const raw of languages) {
    const tag = raw.toLowerCase()
    if (!tag.startsWith('zh')) continue
    if (/-(hant|tw|hk|mo)\b/.test(tag)) return 'zh-Hant'
    return 'zh-Hans'
  }
  return 'en'
}

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && saved in messages) return saved as Lang
  } catch {
    // Storage can be unavailable (private mode); fall back to the browser.
  }
  return detectLang(navigator.languages ?? [navigator.language])
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // Not persisted; the choice still applies to this tab.
  }
}

export function translate(
  lang: Lang,
  key: MessageKey,
  vars: Record<string, string> = {},
): string {
  const template = messages[lang][key] ?? en[key]
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
}
