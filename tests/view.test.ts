import { expect, test } from 'bun:test'

import { planMarkdown } from '../src/markdown'
import { interleave } from '../src/view'

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
