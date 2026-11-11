// Which language the person reads and writes, from what is set, never assumed.

const CODES = [
  'af', 'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fil', 'fr', 'he', 'hi', 'hr',
  'hu', 'id', 'it', 'ja', 'kk', 'ko', 'lt', 'lv', 'mn', 'ms', 'nb', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl',
  'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'yue', 'zh',
]

const CODE_SHAPE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/

function names(code: string): string[] {
  const out: string[] = []
  for (const locale of ['en', code]) {
    try {
      const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
      if (name) out.push(name.toLowerCase())
    } catch {
      // no names for this locale; the code alone still matches
    }
  }
  return out
}

/**
 * A language code from a code ("ko", "pt-BR"), a locale ("ko_KR.UTF-8"), or a
 * language's name in English or in itself ("Korean", "한국어", "日本語").
 * Undefined when nothing matches.
 */
export function toLanguageCode(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (!v || v === 'C' || v === 'POSIX') return undefined
  const locale = v.split('.')[0]?.split('@')[0] ?? ''
  if (CODE_SHAPE.test(locale)) return locale.replace('_', '-').split('-')[0]?.toLowerCase()
  const lower = v.toLowerCase()
  for (const code of CODES) if (names(code).includes(lower)) return code
  // "Korean (South Korea)" and similar
  const head = lower.split(/[\s(,]/)[0] ?? ''
  for (const code of CODES) if (names(code).includes(head)) return code
  return undefined
}

/**
 * The person's language: the mod's own option, else a host `language` setting
 * (OMP has none; index.ts passes undefined), else the system locale, else English
 * (nothing to translate).
 */
export function pickLanguage(option: string, setting: unknown, locales: (string | undefined)[]): { code: string; from: 'option' | 'setting' | 'locale' | 'none' } {
  const fromOption = toLanguageCode(option)
  if (fromOption) return { code: fromOption, from: 'option' }
  const fromSetting = typeof setting === 'string' ? toLanguageCode(setting) : undefined
  if (fromSetting) return { code: fromSetting, from: 'setting' }
  for (const l of locales) {
    const code = toLanguageCode(l)
    if (code) return { code, from: 'locale' }
  }
  return { code: 'en', from: 'none' }
}
