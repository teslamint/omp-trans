// Pure helpers that turn a Plan plus its translations into display Markdown.

import { buildBlock, unmaskAt, type Plan } from './markdown'
import { t } from './strings'
import type { View } from './types'

export const VIEWS: View[] = ['auto', 'interleave', 'below', 'translated', 'original']

/** FNV-1a over UTF-16 code units, base 36. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + text.length.toString(36)
}

export const keyOf = (text: string) => hash(text.trim())

export function quote(md: string): string {
  return md
    .split('\n')
    .map(line => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n')
}

const TRANSLATABLE: Record<string, true> = { prose: true, heading: true, list: true, quote: true, table: true }

/** Each block followed by its translation as a quote; headings joined on one line. */
export function interleave(plan: Plan, out: readonly (string | null)[]): string {
  return plan.blocks
    .map(block => {
      if (!TRANSLATABLE[block.kind]) return block.original
      const units = block.parts.some(p => typeof p !== 'string')
      if (!units) return block.original
      const tr = buildBlock(plan, block, out)
      if (tr == null || tr === block.original) return block.original
      if (block.kind === 'heading') {
        const original = block.original.replace(/\s+$/, '')
        const body = tr.replace(/^\s*#{1,6}\s*/, '').trim()
        return `${original} · ${body}`
      }
      return `${block.original}\n${quote(tr)}`
    })
    .join('\n')
}

/** The translation with code blocks folded to one line, for the `below` view. */
export function foldedTranslation(plan: Plan, out: readonly (string | null)[]): string {
  return plan.blocks
    .map(block => {
      if (block.kind === 'code') {
        const lines = block.original.split('\n').length
        return `\`⋯ ${t('code')} (${lines})\``
      }
      return block.parts.map(p => (typeof p === 'string' ? p : (out[p.unit] ?? unmaskAt(plan, p.unit)))).join('')
    })
    .join('\n')
}
