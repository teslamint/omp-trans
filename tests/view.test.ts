import { expect, test } from 'bun:test'

import { buildDocument, planMarkdown, unmask } from '../src/markdown'
import { foldedTranslation, interleave } from '../src/view'

const TABLE = '| Key | Notes |\n| --- | --- |\n| a | first |'

const translate = (md: string) => {
  const plan = planMarkdown(md)
  const out = plan.units.map(u => `T(${u.text})`)
  return interleave(plan, out)
}

// A `>` line right under a table row is read as one more row of that table, so the quoted
// translation has to start after a blank line.
test('a table translation is separated from the original table by a blank line', () => {
  const lines = translate(TABLE).split('\n')
  const at = lines.findIndex(l => l.startsWith('> '))
  expect(at).toBeGreaterThan(0)
  expect(lines[at - 1]).toBe('')
  expect(lines[at - 2]).toBe('| a | first |')
})

test('the quoted translation keeps every row of the table', () => {
  const quoted = translate(TABLE)
    .split('\n')
    .filter(l => l.startsWith('>'))
  expect(quoted).toHaveLength(3)
  expect(quoted[1]).toBe('> | --- | --- |')
})

// Without a blank line after the quote, the next line would continue the blockquote.
test('text right after a table does not continue the quoted translation', () => {
  const lines = translate(`${TABLE}\nFollowing text here`).split('\n')
  const last = lines.findIndex(l => l.startsWith('> | T(a)'))
  expect(last).toBeGreaterThan(0)
  expect(lines[last + 1]).toBe('')
  expect(lines[last + 2]).toBe('Following text here')
})

test('a table followed by a blank line gets no extra blank line', () => {
  const lines = translate(`${TABLE}\n\nNext paragraph`).split('\n')
  const last = lines.findIndex(l => l.startsWith('> | T(a)'))
  expect(lines[last + 1]).toBe('')
  expect(lines[last + 2]).toBe('Next paragraph')
})

test('non-table blocks keep the quote directly under the original', () => {
  expect(translate('Hello there')).toBe('Hello there\n> T(Hello there)')
})

// A raw `|` in a translated cell ends the cell early: the rest of the translation is dropped on screen.
const PIPE_TABLE = '| Option | Meaning |\n| --- | --- |\n| plain | Use A or B |'
const plan = planMarkdown(PIPE_TABLE)
const withPipe = plan.units.map(u => (u.text === 'Use A or B' ? 'Usa A o B (a | b)' : u.text))

test('a pipe inside a translated cell is escaped in the interleave view', () => {
  const quoted = interleave(plan, withPipe)
    .split('\n')
    .filter(l => l.startsWith('>'))
  expect(quoted.at(-1)).toBe('> | plain | Usa A o B (a \\| b) |')
})

test('a pipe already escaped by the translator is not escaped twice', () => {
  const out = plan.units.map(u => (u.text === 'Use A or B' ? 'Usa A o B (a \\| b)' : u.text))
  expect(interleave(plan, out)).toContain('> | plain | Usa A o B (a \\| b) |')
})

test('the translated and below views escape cell pipes too', () => {
  expect(buildDocument(plan, withPipe).split('\n').at(-1)).toBe('| plain | Usa A o B (a \\| b) |')
  expect(foldedTranslation(plan, withPipe).split('\n').at(-1)).toBe('| plain | Usa A o B (a \\| b) |')
})

test('a pipe in translated prose is left alone', () => {
  const prose = planMarkdown('Use A or B')
  expect(buildDocument(prose, ['Usa A | B'])).toBe('Usa A | B')
})

test('the original cell text is kept when a cell has no translation', () => {
  expect(buildDocument(plan, plan.units.map(() => null))).toBe(PIPE_TABLE)
})

test('a pipe inside an inline code span in a cell is kept as written', () => {
  const md = '| Option | Meaning |\n| --- | --- |\n| plain | Use `a|b` here |'
  const p = planMarkdown(md)
  expect(buildDocument(p, p.units.map(unmask))).toBe(md)
  const out = p.units.map(u => (u.text.startsWith('Use') ? 'Usa ⟦0⟧ aquí | ahora' : u.text))
  const restored = out.map((s, i) => s.replace(/⟦\s*(\d+)\s*⟧/g, (_, k) => p.units[i]!.spans[+k] ?? ''))
  expect(buildDocument(p, restored).split('\n').at(-1)).toBe('| plain | Usa `a|b` aquí \\| ahora |')
})
