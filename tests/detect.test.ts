import { expect, test } from 'bun:test'

import { alreadyInScript, scriptOf } from '../src/detect'
import { translateUnits, type EngineConfig, type Io } from '../src/engines'
import { maskText } from '../src/markdown'

const ENGLISH_REPLY = 'The loop calls `fetchUser()` on every pass, so move it out of the loop.'

test('an English reply is never "already in the reader language" for Latin-script languages', () => {
  for (const lang of ['es', 'de', 'fr', 'pt-BR', 'it', 'nl', 'tr']) {
    expect(scriptOf(lang)).toBe('Latin')
    expect(alreadyInScript(ENGLISH_REPLY, scriptOf(lang))).toBe(false)
  }
})

test('script share still skips replies already written in a non-Latin reader script', () => {
  expect(alreadyInScript('루프가 매 반복마다 `fetchUser()`를 호출합니다.', scriptOf('ko'))).toBe(true)
  expect(alreadyInScript(ENGLISH_REPLY, scriptOf('ko'))).toBe(false)
  expect(alreadyInScript('Цикл вызывает функцию на каждой итерации.', scriptOf('ru'))).toBe(true)
})

test('a Spanish reader gets an English reply translated through the engine', async () => {
  const cfg: EngineConfig = { kind: 'haiku', haikuModel: 'm', openaiBaseUrl: '', openaiModel: '', openaiApiKey: '', command: '', fallback: true }
  const io: Io = {
    complete: async req => ({ ok: true, text: JSON.stringify((JSON.parse(req.prompt) as string[]).map(s => `[es] ${s}`)) }),
    fetch: async () => ({ status: 500, ok: false, text: '' }),
    run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  }
  const r = await translateUnits(io, cfg, [maskText(ENGLISH_REPLY)!], 'en', 'es')
  expect(r.out).toEqual([`[es] ${ENGLISH_REPLY}`])
})
