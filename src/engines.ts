// Translation engines. Each takes masked unit texts and answers translations
// in the same order; placeholders are restored and checked here, so an engine
// that loses or alters one only costs that unit.

import { restoreUnit, type Unit } from './markdown'

export type EngineKind = 'haiku' | 'openai' | 'command'

export type EngineConfig = {
  kind: EngineKind
  haikuModel: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey: string
  command: string
  fallback: boolean
}

/** What the engines need from the host; register.tsx adapts `$` to it. */
export type Io = {
  complete(req: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }): Promise<
    { ok: true; text: string } | { ok: false; reason: string }
  >
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; ok: boolean; text: string }>
  run(argv: string[], stdin: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export type Translated = {
  /** Restored translations, null for a unit that failed. */
  out: (string | null)[]
  /** The engine that produced the last batch (`haiku` after a fallback). */
  engine: string
  /** Why something failed, when anything did. */
  error?: string
}

const MAX_UNITS = 40
const MAX_CHARS = 6000
const TIMEOUT_MS = 30_000

export function languageName(code: string): string {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' })
    return names.of(code) ?? code
  } catch {
    return code
  }
}

export function systemPrompt(from: string, to: string): string {
  const source = languageName(from)
  const target = languageName(to)
  return [
    `You are a translation engine for a software developer's conversation with a coding assistant.`,
    `Translate each string of the JSON array from ${source} to ${target}.`,
    `Reply with ONLY a JSON array of strings: the same length and order as the input, one translation per input string. No prose, no code fence.`,
    `Rules:`,
    `- Tokens like ⟦0⟧, ⟦1⟧ stand for code, paths or links. Copy every token exactly once, unchanged, where it belongs in the translated sentence.`,
    `- Keep Markdown markers (**, *, _, ~~, [ ]) around the words they wrap.`,
    `- Keep technical terms, product names and identifiers that ${target}-speaking developers normally leave in English.`,
    `- Keep the tone: terse stays terse. Do not add, explain or omit anything.`,
    `- A string already in ${target} is returned unchanged.`,
  ].join('\n')
}

/** Reads a JSON array of strings out of a model's reply. */
export function parseArray(reply: string): string[] | null {
  let text = reply.trim()
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/)
  if (fence) text = fence[1] ?? text
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(value)) return null
    if (!value.every(v => typeof v === 'string')) return null
    return value as string[]
  } catch {
    return null
  }
}

/** Splits units into batches by count and size. */
export function batches(texts: string[]): number[][] {
  const out: number[][] = []
  let cur: number[] = []
  let size = 0
  texts.forEach((t, i) => {
    if (cur.length > 0 && (cur.length >= MAX_UNITS || size + t.length > MAX_CHARS)) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(i)
    size += t.length
  })
  if (cur.length > 0) out.push(cur)
  return out
}

type Raw = (texts: string[]) => Promise<string[]>

class EngineError extends Error {}

function haikuRaw(io: Io, cfg: EngineConfig, from: string, to: string): Raw {
  const system = systemPrompt(from, to)
  return async texts => {
    const prompt = JSON.stringify(texts)
    const r = await io.complete({
      model: cfg.haikuModel || 'haiku',
      system,
      prompt,
      maxTokens: Math.min(16_000, 512 + prompt.length * 2),
      timeoutMs: TIMEOUT_MS,
    })
    if (!r.ok) throw new EngineError(`haiku: ${r.reason}`)
    const arr = parseArray(r.text)
    if (!arr) throw new EngineError('haiku: reply was not a JSON array')
    return arr
  }
}

function openaiRaw(io: Io, cfg: EngineConfig, from: string, to: string): Raw {
  const system = systemPrompt(from, to)
  return async texts => {
    if (!cfg.openaiBaseUrl || !cfg.openaiModel) throw new EngineError('openai: openaiBaseUrl and openaiModel are not set')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (cfg.openaiApiKey) headers.authorization = `Bearer ${cfg.openaiApiKey}`
    const res = await io.fetch(cfg.openaiBaseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.openaiModel,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(texts) },
        ],
      }),
    })
    if (!res.ok) throw new EngineError(`openai: HTTP ${res.status}`)
    let content: unknown
    try {
      content = (JSON.parse(res.text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
    } catch {
      throw new EngineError('openai: response was not JSON')
    }
    const arr = typeof content === 'string' ? parseArray(content) : null
    if (!arr) throw new EngineError('openai: reply was not a JSON array')
    return arr
  }
}

/** Splits a command line into argv, honouring single and double quotes. */
export function splitArgv(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let has = false
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += ch
  }
  if (has || cur) out.push(cur)
  return out
}

function commandRaw(io: Io, cfg: EngineConfig, from: string, to: string): Raw {
  return async texts => {
    const argv = splitArgv(cfg.command)
    if (argv.length === 0) throw new EngineError('command: no command is set')
    const r = await io.run(argv, JSON.stringify({ from, to, lines: texts }), TIMEOUT_MS)
    if (r.exitCode !== 0) throw new EngineError(`command: exit ${r.exitCode}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`)
    let value: unknown
    try {
      value = JSON.parse(r.stdout)
    } catch {
      throw new EngineError('command: stdout was not JSON')
    }
    const lines = Array.isArray(value) ? value : (value as { lines?: unknown })?.lines
    if (!Array.isArray(lines) || !lines.every(l => typeof l === 'string')) throw new EngineError('command: stdout had no "lines" array')
    return lines as string[]
  }
}

function rawFor(kind: EngineKind, io: Io, cfg: EngineConfig, from: string, to: string): Raw {
  if (kind === 'openai') return openaiRaw(io, cfg, from, to)
  if (kind === 'command') return commandRaw(io, cfg, from, to)
  return haikuRaw(io, cfg, from, to)
}

/** Runs a batch; a reply of the wrong length is retried once as two halves. */
async function runBatch(raw: Raw, texts: string[], depth = 0): Promise<(string | null)[]> {
  const arr = await raw(texts)
  if (arr.length === texts.length) return arr
  if (depth > 0 || texts.length < 2) return texts.map(() => null)
  const mid = Math.ceil(texts.length / 2)
  const [a, b] = await Promise.all([runBatch(raw, texts.slice(0, mid), 1), runBatch(raw, texts.slice(mid), 1)])
  return [...a, ...b]
}

/** Translates units from `from` to `to`, falling back to haiku when allowed. */
export async function translateUnits(io: Io, cfg: EngineConfig, units: Unit[], from: string, to: string): Promise<Translated> {
  const out: (string | null)[] = units.map(() => null)
  const texts = units.map(u => u.text)
  let engine: string = cfg.kind
  let error: string | undefined

  for (const batch of batches(texts)) {
    const slice = batch.map(i => texts[i] ?? '')
    let got: (string | null)[] | null = null
    try {
      got = await runBatch(rawFor(cfg.kind, io, cfg, from, to), slice)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (cfg.kind !== 'haiku' && cfg.fallback) {
        try {
          got = await runBatch(rawFor('haiku', io, cfg, from, to), slice)
          engine = 'haiku'
        } catch (e2) {
          error += `; haiku: ${e2 instanceof Error ? e2.message : String(e2)}`
        }
      }
    }
    if (!got) continue
    batch.forEach((unitIndex, k) => {
      const t = got![k]
      const unit = units[unitIndex]
      out[unitIndex] = t == null || !unit ? null : restoreUnit(unit, t)
    })
  }
  if (!error && out.some(t => t === null)) error = 'some lines came back without their code placeholders'
  return { out, engine, error }
}
