import { expect, test } from 'bun:test'

import { translateUnits, type EngineConfig, type Io } from '../src/engines'
import { maskText, planMarkdown } from '../src/markdown'
import { pickLanguage, toLanguageCode } from '../src/language'
import { interleave } from '../src/view'

test('interleave keeps every original line and adds translations as quotes', () => {
  const plan = planMarkdown('- one item\n- two item\n\n| A | B |\n| --- | --- |\n| x y | z w |')
  const out = plan.units.map(u => `[ko] ${u.text}`)
  const text = interleave(plan, out)
  expect(text).toContain('- one item\n- two item\n> - [ko] one item\n> - [ko] two item')
  expect(text).toContain('| A | B |\n| --- | --- |\n| x y | z w |\n\n> | [ko] A | [ko] B |')
})

const CFG: EngineConfig = {
  kind: 'openai',
  haikuModel: 'haiku',
  openaiBaseUrl: 'http://localhost:1/v1',
  openaiModel: 'm',
  openaiApiKey: '',
  command: '',
  fallback: true,
}

function io(overrides: Partial<Io>): Io {
  return {
    complete: async req => ({ ok: true, text: JSON.stringify((JSON.parse(req.prompt) as string[]).map(s => `H:${s}`)) }),
    fetch: async () => ({ status: 403, ok: false, text: '' }),
    run: async () => ({ exitCode: 1, stdout: '', stderr: 'nope' }),
    ...overrides,
  }
}

test('a failing external engine falls back to haiku, labelled haiku', async () => {
  const unit = maskText('Run `npm test` now')!
  const r = await translateUnits(io({}), CFG, [unit], 'en', 'ko')
  expect(r.engine).toBe('haiku')
  expect(r.out).toEqual(['H:Run `npm test` now'])
  expect(r.error).toContain('HTTP 403')
})

test('with fallback off the failure is reported and nothing is translated', async () => {
  const unit = maskText('Run the tests')!
  const r = await translateUnits(io({}), { ...CFG, fallback: false }, [unit], 'en', 'ko')
  expect(r.out).toEqual([null])
  expect(r.error).toBe('openai: HTTP 403')
})

test('an engine that drops a placeholder loses only that line', async () => {
  const units = [maskText('Call `a()` here')!, maskText('Plain words')!]
  const r = await translateUnits(
    io({ complete: async () => ({ ok: true, text: JSON.stringify(['dropped the code', '그냥 단어']) }) }),
    { ...CFG, kind: 'haiku' },
    units,
    'en',
    'ko',
  )
  expect(r.out).toEqual([null, '그냥 단어'])
})

test('the command engine speaks JSON over stdin and stdout', async () => {
  let stdin = ''
  const r = await translateUnits(
    io({
      run: async (argv, input) => {
        stdin = input
        expect(argv).toEqual(['apple-translate', '--quiet'])
        return { exitCode: 0, stdout: JSON.stringify({ lines: ['안녕'] }), stderr: '' }
      },
    }),
    { ...CFG, kind: 'command', command: 'apple-translate --quiet' },
    [maskText('Hello')!],
    'en',
    'ko',
  )
  expect(JSON.parse(stdin)).toEqual({ from: 'en', to: 'ko', lines: ['Hello'] })
  expect(r.out).toEqual(['안녕'])
  expect(r.engine).toBe('command')
})

test('language codes come from codes, locales and names', () => {
  expect(toLanguageCode('ko')).toBe('ko')
  expect(toLanguageCode('ko_KR.UTF-8')).toBe('ko')
  expect(toLanguageCode('pt-BR')).toBe('pt')
  expect(toLanguageCode('Korean')).toBe('ko')
  expect(toLanguageCode('한국어')).toBe('ko')
  expect(toLanguageCode('日本語')).toBe('ja')
  expect(toLanguageCode('Japanese')).toBe('ja')
  expect(toLanguageCode('spanish')).toBe('es')
  expect(toLanguageCode('C')).toBeUndefined()
  expect(toLanguageCode('')).toBeUndefined()
  expect(toLanguageCode('Klingon')).toBeUndefined()
})

test('the option wins, then the language setting, then the locale, else English', () => {
  expect(pickLanguage('ja', 'Korean', ['de_DE.UTF-8'])).toEqual({ code: 'ja', from: 'option' })
  expect(pickLanguage('', 'Korean', ['de_DE.UTF-8'])).toEqual({ code: 'ko', from: 'setting' })
  expect(pickLanguage('', undefined, [undefined, 'de_DE.UTF-8'])).toEqual({ code: 'de', from: 'locale' })
  expect(pickLanguage('', undefined, ['C', undefined])).toEqual({ code: 'en', from: 'none' })
})
