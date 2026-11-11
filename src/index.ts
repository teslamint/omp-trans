/**
 * cc-trans for OMP: write and read in your own language while the model works in English.
 *
 * Prompts in your language are translated to English on submit (`input` event); assistant replies
 * keep their English and gain a translation (assistant text renderer, display only). Code, paths and
 * Markdown structure never go through the translator (see markdown.ts).
 */
import { completeSimple } from '@oh-my-pi/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry'
import { getPluginSettings } from '@oh-my-pi/pi-coding-agent/extensibility/plugins'

import { alreadyInScript, scriptOf, scriptShare } from './detect'
import { translateUnits, type EngineConfig, type EngineKind, type Io } from './engines'
import { pickLanguage } from './language'
import { buildDocument, planMarkdown, unmask, type Unit } from './markdown'
import { t } from './strings'
import type { ReplyEntry, View } from './types'
import { VIEWS, foldedTranslation, interleave, keyOf, quote } from './view'

const PLUGIN = 'cc-trans'
const WIDGET = 'cc-trans-preview'
const STATUS = 'cc-trans'
const MAX_IN_FLIGHT = 3
const PREVIEW_DELAY_MS = 700
const TICK_MS = 250
const PROMPT_DEADLINE_MS = 15_000

type Config = EngineConfig & { languageOption: string; language: string; view: View; preview: boolean }

/** Raw option values: omp plugin settings, then CC_TRANS_<NAME> environment variables. */
function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
  const kind = str(options.engine, 'haiku')
  const view = str(options.view, 'auto')
  return {
    languageOption: str(options.language, ''),
    language: 'en',
    kind: (['haiku', 'openai', 'command'].includes(kind) ? kind : 'haiku') as EngineKind,
    view: (VIEWS.includes(view as View) ? view : 'auto') as View,
    preview: options.preview !== false && options.preview !== 'false',
    // Claude's "haiku" has no meaning here: the default is omp's smol role.
    haikuModel: str(options.model, '@smol'),
    openaiBaseUrl: str(options.openaiBaseUrl, ''),
    openaiModel: str(options.openaiModel, ''),
    openaiApiKey: str(options.openaiApiKey, ''),
    command: str(options.command, ''),
    fallback: options.fallback !== false && options.fallback !== 'false',
  }
}

const OPTION_NAMES = ['language', 'engine', 'view', 'preview', 'model', 'openaiBaseUrl', 'openaiModel', 'openaiApiKey', 'command', 'fallback']

async function loadOptions(cwd: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const name of OPTION_NAMES) {
    const env = process.env[`CC_TRANS_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]
    if (env !== undefined && env !== '') out[name] = env
  }
  try {
    Object.assign(out, await getPluginSettings(PLUGIN, cwd))
  } catch {
    // not installed as a plugin, or the plugin API is unavailable: environment only
  }
  return out
}

// ---------------------------------------------------------------------------
// state: module level, shared by every session in the process

let cfg: Config = readConfig({})
let script = scriptOf(cfg.language)
let engineLabel: string = cfg.kind
let languageFrom: 'option' | 'locale' | 'none' = 'none'
let enabled = true
let viewOverride: View | null = null
/** Replies older than this process's first session start are not translated: resuming sends nothing. */
let liveSince = 0

const idle = () => cfg.language.toLowerCase().startsWith('en')

type Job = { key: string; text: string }
const jobs = new Map<string, Job>()
const inflight = new Set<string>()
const replies = new Map<string, ReplyEntry>()
/** Reply key → timestamps of the messages drawing it, redrawn when its translation lands. */
const drawnBy = new Map<string, Set<number>>()
const unitCache = new Map<string, string>()
const promptCache = new Map<string, { english: string; engine: string }>()
const classified = new Map<string, boolean>()
let latestDraft = ''
let draftChangedAt = 0
let previewDue = false
let previewRunning = false
let previewKey = ''

// ---------------------------------------------------------------------------
// host adapters

function ioFor(ctx: ExtensionContext): Io {
  return {
    async complete(req) {
      const model = ctx.models.resolve(req.model) ?? ctx.models.current()
      if (!model) return { ok: false, reason: 'no-model' }
      try {
        const message = await completeSimple(
          model,
          { systemPrompt: [req.system], messages: [{ role: 'user', content: req.prompt, timestamp: Date.now() }] },
          {
            apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
            disableReasoning: true,
            maxTokens: req.maxTokens,
            signal: AbortSignal.timeout(req.timeoutMs),
          },
        )
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          return { ok: false, reason: message.errorMessage ?? message.stopReason }
        }
        const text = message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
        return { ok: true, text }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
    async fetch(url, init) {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
      return { status: r.status, ok: r.ok, text: await r.text() }
    },
    async run(argv, stdin, timeoutMs) {
      const proc = Bun.spawn(argv, { stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { exitCode, stdout, stderr }
    },
  }
}

function resolveLanguage() {
  const picked = pickLanguage(cfg.languageOption, undefined, [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG])
  cfg.language = picked.code
  languageFrom = picked.from === 'setting' ? 'option' : picked.from
  script = scriptOf(cfg.language)
}

// ---------------------------------------------------------------------------
// translation

async function translatePlanUnits(ctx: ExtensionContext, units: Unit[], from: string, to: string) {
  const out: (string | null)[] = units.map(() => null)
  const missing: number[] = []
  units.forEach((u, i) => {
    const hit = unitCache.get(`${from}>${to}|${unmask(u)}`)
    if (hit != null) out[i] = hit
    else missing.push(i)
  })
  let engine = cfg.kind as string
  let error: string | undefined
  if (missing.length > 0) {
    const r = await translateUnits(ioFor(ctx), cfg, missing.map(i => units[i]!), from, to)
    engine = r.engine
    error = r.error
    missing.forEach((ui, k) => {
      const tr = r.out[k] ?? null
      out[ui] = tr
      if (tr != null) unitCache.set(`${from}>${to}|${unmask(units[ui]!)}`, tr)
    })
  }
  return { out, engine, error }
}

async function translateReply(ctx: ExtensionContext, job: Job) {
  const plan = planMarkdown(job.text)
  if (plan.units.length === 0 || alreadyInScript(job.text, script)) {
    replies.set(job.key, { status: 'skipped', out: [], engine: cfg.kind })
    return
  }
  const r = await translatePlanUnits(ctx, plan.units, 'en', cfg.language)
  replies.set(job.key, {
    status: r.out.every(o => o == null) ? 'failed' : 'done',
    out: r.out,
    engine: r.engine,
    ...(r.error ? { error: r.error } : {}),
  })
}

type PromptResult = { english: string; engine: string } | { error: string }

async function translatePrompt(ctx: ExtensionContext, text: string): Promise<PromptResult> {
  const hit = promptCache.get(text)
  if (hit) return hit
  const plan = planMarkdown(text)
  if (plan.units.length === 0) return { error: 'nothing to translate' }
  let r = await translatePlanUnits(ctx, plan.units, cfg.language, 'en')
  // The lines that came back are cached; only the ones that failed are sent again.
  if (r.out.some(o => o == null)) r = await translatePlanUnits(ctx, plan.units, cfg.language, 'en')
  if (r.out.every(o => o == null)) return { error: r.error ?? 'no translation' }
  const done = { english: buildDocument(plan, r.out), engine: r.engine }
  promptCache.set(text, done)
  return done
}

/** Whether a draft is in the person's language and worth translating. */
async function needsTranslation(ctx: ExtensionContext, text: string): Promise<boolean> {
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed.startsWith('/') || trimmed.startsWith('!') || trimmed.startsWith('$')) return false
  if (script !== 'Latin') return scriptShare(trimmed, script) >= 0.2
  if (idle()) return false
  const cached = classified.get(trimmed)
  if (cached !== undefined) return cached
  // A Latin-script language cannot be told from English by script: ask the model.
  const r = await ioFor(ctx).complete({
    model: cfg.haikuModel,
    system: 'Classify the language of the user text. Reply with exactly one word: "english" if it is English, otherwise "other".',
    prompt: trimmed,
    maxTokens: 16,
    timeoutMs: 15_000,
  })
  const yes = r.ok && r.text.trim().toLowerCase().startsWith('other')
  if (r.ok) classified.set(trimmed, yes)
  return yes
}

// ---------------------------------------------------------------------------
// reply queue

function enqueue(key: string, text: string) {
  if (idle() || !enabled || replies.has(key) || jobs.has(key) || inflight.has(key)) return
  replies.set(key, { status: 'pending', out: [], engine: cfg.kind })
  jobs.set(key, { key, text })
}

function redraw(ctx: ExtensionContext, key: string) {
  for (const ts of drawnBy.get(key) ?? []) ctx.ui.rerenderMessage(ts)
}

function tick(ctx: ExtensionContext) {
  while (inflight.size < MAX_IN_FLIGHT && jobs.size > 0) {
    const job = jobs.values().next().value as Job
    jobs.delete(job.key)
    inflight.add(job.key)
    translateReply(ctx, job)
      .catch(e => {
        replies.set(job.key, { status: 'failed', out: [], engine: cfg.kind, error: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => {
        inflight.delete(job.key)
        redraw(ctx, job.key)
        showStatus(ctx)
      })
    showStatus(ctx)
  }
}

function showStatus(ctx: ExtensionContext) {
  if (idle() || !enabled) return ctx.ui.setStatus(STATUS, undefined)
  const queued = jobs.size + inflight.size
  ctx.ui.setStatus(STATUS, `${cfg.language}↔en · ${engineLabel}${queued > 0 ? ` · ${t('queuedShort', String(queued))}` : ''}`)
}

// ---------------------------------------------------------------------------
// live preview of the draft, above the prompt

async function maybePreview(ctx: ExtensionContext) {
  if (!cfg.preview || !enabled || idle()) return clearPreview(ctx)
  const draft = ctx.ui.getEditorText()
  if (draft !== latestDraft) {
    latestDraft = draft
    draftChangedAt = Date.now()
    previewDue = true
    if (draft.trim() === '') clearPreview(ctx)
    return
  }
  if (!previewDue || previewRunning || Date.now() - draftChangedAt < PREVIEW_DELAY_MS) return
  previewDue = false
  previewRunning = true
  try {
    if (!(await needsTranslation(ctx, draft))) return clearPreview(ctx)
    const r = await translatePrompt(ctx, draft)
    if (latestDraft !== draft) return
    previewKey = draft
    ctx.ui.setWidget(WIDGET, ['EN ▸ ' + ('english' in r ? r.english : t('failed'))], { placement: 'aboveEditor' })
  } finally {
    previewRunning = false
  }
}

function clearPreview(ctx: ExtensionContext) {
  if (previewKey === '') return
  previewKey = ''
  ctx.ui.setWidget(WIDGET, undefined)
}

// ---------------------------------------------------------------------------

export default function ccTrans(pi: ExtensionAPI): void {
  pi.setLabel('cc-trans')

  // A reply renderer only runs while this setting is on; turn it on unless the user pinned it.
  const enableRenderers = () => {
    try {
      const handle = lookup('extensionRenderers.assistantText')
      if (handle && !handle.isConfigured(pi.pi.settings)) handle.override(pi.pi.settings, true)
    } catch {
      // the user can switch it on under Tools > Extensions > Extension Reply Renderers
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.agent.kind !== 'main') return
    cfg = readConfig(await loadOptions(ctx.cwd))
    engineLabel = cfg.kind === 'openai' && cfg.openaiModel ? cfg.openaiModel : cfg.kind
    resolveLanguage()
    if (liveSince === 0) liveSince = Date.now()
    enableRenderers()
    if (!ctx.hasUI) return
    showStatus(ctx)
    const timer = ctx.setInterval(() => {
      tick(ctx)
      void maybePreview(ctx)
    }, TICK_MS)
    pi.on('session_shutdown', () => ctx.clearTimer(timer))
  })

  // Prompt: translated to English before it is recorded, so the model reads English.
  pi.on('input', async (event, ctx) => {
    if (ctx.agent.kind !== 'main' || event.source === 'extension' || !enabled || event.text.startsWith('/')) return
    previewDue = false
    if (!(await needsTranslation(ctx, event.text))) return

    ctx.ui.setWorkingMessage?.(t('translatingPrompt', engineLabel))
    let r: PromptResult
    const deadline = Promise.withResolvers<PromptResult>()
    const deadlineTimer = setTimeout(() => deadline.resolve({ error: 'timed out' }), PROMPT_DEADLINE_MS)
    try {
      r = await Promise.race([translatePrompt(ctx, event.text), deadline.promise])
    } catch (err) {
      r = { error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(deadlineTimer)
      ctx.ui.setWorkingMessage?.(undefined)
    }
    clearPreview(ctx)
    if ('error' in r) {
      ctx.ui.notify(t('promptFailed', r.error), 'warning')
      return
    }
    // Recorded for the person's own history; entries never reach the model.
    pi.appendEntry('cc-trans-prompt', { native: event.text, english: r.english, engine: r.engine })
    ctx.ui.notify(`EN ▸ ${r.english}`, 'info')
    return { text: r.english }
  })

  // Replies: English as written, plus the translation, drawn by the host's text renderer.
  pi.registerAssistantTextRenderer(({ message, text, streaming }) => {
    if (!enabled || idle() || !text.trim()) return undefined
    const key = keyOf(text)
    let stamps = drawnBy.get(key)
    if (!stamps) drawnBy.set(key, (stamps = new Set()))
    stamps.add(message.timestamp)

    const entry = replies.get(key)
    if (!entry) {
      // Streaming blocks are translated once final; replies from before this run are left alone.
      if (!streaming && message.timestamp >= liveSince) enqueue(key, text)
      return undefined
    }
    if (entry.status === 'skipped') return undefined
    if (entry.status === 'pending') return `${text}\n\n_⋯ ${t('translating')}_`
    if (entry.status === 'failed') return `${text}\n\n_${t('failed')}: ${entry.error ?? '?'}_`

    const view = viewOverride ?? cfg.view
    if (view === 'original') return undefined
    const plan = planMarkdown(text)
    const footer = entry.engine !== cfg.kind ? `\n\n_· ${entry.engine}_` : ''
    if (view === 'translated') return buildDocument(plan, entry.out) + footer
    if (view === 'below') return `${text}\n\n${quote(foldedTranslation(plan, entry.out))}${footer}`
    return interleave(plan, entry.out) + footer
  })

  pi.registerCommand('translate', {
    description: 'Translation: on, off, status, or view <auto|interleave|below|translated|original>.',
    handler: async (args, ctx) => {
      const [word, arg] = args.trim().split(/\s+/)
      const say = (text: string) => ctx.ui.notify(text, 'info')
      if (!word || word === 'on' || word === 'off') {
        enabled = word ? word === 'on' : !enabled
        if (!enabled) clearPreview(ctx)
        showStatus(ctx)
        return say(t(enabled ? 'turnedOn' : 'turnedOff'))
      }
      if (word === 'view') {
        if (!arg || !VIEWS.includes(arg as View)) return say(t('viewUsage', VIEWS.join(' · ')))
        viewOverride = arg as View
        for (const stamps of drawnBy.values()) for (const ts of stamps) ctx.ui.rerenderMessage(ts)
        return say(t('viewSet', arg))
      }
      if (word === 'status') {
        const lines = [
          `${t('status')}: ${enabled ? 'on' : 'off'}`,
          `${t('language')}: ${cfg.language} ↔ en (${t(`from_${languageFrom}`)})`,
          `${t('engine')}: ${engineLabel}${cfg.kind !== 'haiku' && cfg.fallback ? ' (→ model)' : ''}`,
          `${t('view')}: ${viewOverride ?? cfg.view}`,
          `${t('preview')}: ${cfg.preview ? 'on' : 'off'}`,
          `${t('queued')}: ${jobs.size + inflight.size}`,
        ]
        if (cfg.kind === 'openai' && (!cfg.openaiBaseUrl || !cfg.openaiModel)) lines.push(t('missingOpenai'))
        if (cfg.kind === 'command' && !cfg.command) lines.push(t('missingCommand'))
        return say(lines.join('\n'))
      }
      return say(t('usage'))
    },
  })
}
