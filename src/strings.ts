// The mod's own words. Always English, like OMP's own interface:
// only the translations are in the person's language.

type Key =
  | 'code'
  | 'translating'
  | 'translatingPrompt'
  | 'promptFailed'
  | 'failed'
  | 'turnedOn'
  | 'turnedOff'
  | 'viewUsage'
  | 'viewSet'
  | 'status'
  | 'language'
  | 'engine'
  | 'view'
  | 'preview'
  | 'queued'
  | 'queuedShort'
  | 'missingOpenai'
  | 'missingCommand'
  | 'usage'
  | 'from_option'
  | 'from_locale'
  | 'from_none'

const EN: Record<Key, string> = {
  code: 'code',
  translating: 'translating…',
  translatingPrompt: '🔤 Translating to English… ({0})',
  promptFailed: 'Translation failed, sent as typed: {0}',
  failed: 'translation failed',
  turnedOn: 'Translation is on.',
  turnedOff: 'Translation is off.',
  viewUsage: 'Usage: /translate view <{0}>',
  viewSet: 'Replies are shown as: {0}',
  status: 'Translation',
  language: 'Languages',
  engine: 'Engine',
  view: 'View',
  preview: 'Live preview',
  queued: 'Queued',
  queuedShort: '{0} queued',
  missingOpenai: '⚠ The openai engine needs openaiBaseUrl and openaiModel.',
  missingCommand: '⚠ The command engine needs a command.',
  usage: 'Usage: /translate [on|off|status|view <mode>]',
  from_option: 'from the language option',
  from_locale: 'from the system locale',
  from_none: 'nothing set: no translation',
}

export function t(key: Key, ...args: string[]): string {
  return EN[key].replace(/\{(\d)\}/g, (_: string, i: string) => args[Number(i)] ?? '')
}
