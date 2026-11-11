# omp-trans

**Talk to [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) in your own language. The model still works in English.**

You type in Korean, Japanese, Chinese, Spanish… and the model receives English. It answers in
English, and each reply gets a translation under it. Code, paths, commands and Markdown structure
never go through the translator.

This is an OMP port of [midagedev/cc-trans](https://github.com/midagedev/cc-trans), a Claude Code
mod (MIT). The translation core is upstream's; the Claude Code adapter is replaced by an OMP
extension. The plugin keeps the name `cc-trans`, so commands, settings and `CC_TRANS_*` variables
match upstream.

## Install

```sh
git clone https://github.com/teslamint/omp-trans.git ~/workspace/omp-trans
cd ~/workspace/omp-trans && bun install
omp plugin link ~/workspace/omp-trans
omp plugin config set cc-trans language ko
```

Restart OMP to load it. To try it without installing:

```sh
CC_TRANS_LANGUAGE=ko omp -e ~/workspace/omp-trans/src/index.ts
```

## What it does

| Where | Behavior |
| --- | --- |
| Prompt, on Enter | Text in your language is translated to English and sent. On failure or after 15 s, the original is sent with a warning. Lines starting with `/`, `!` or `$` pass through. |
| Prompt, while typing | 700 ms after you stop typing, `EN ▸ …` appears above the prompt. Enter sends that English with no extra wait. |
| Replies | Each final text block keeps its English and gets a translation. This is display only: the session, exports and model context keep the English. |
| Status line | `ko↔en · <engine> · N queued` |

### Commands

| Command | |
| --- | --- |
| `/translate` | turn translation on or off |
| `/translate on` · `/translate off` | set it explicitly |
| `/translate view <mode>` | change how replies are shown |
| `/translate status` | language, engine, view and queue |

### Views

| View | What you see |
| --- | --- |
| `auto` (default) | same as `interleave` |
| `interleave` | each paragraph, then its translation as a quote |
| `below` | the English reply, then the whole translation |
| `translated` | the translation only, code in place |
| `original` | English only |

To draw replies, the extension turns on **Tools → Extensions → Extension Reply Renderers**
(`extensionRenderers.assistantText`) at session start, unless you set it yourself.

## Your language

The `language` setting wins. Without it, `LC_ALL`, `LC_MESSAGES` and `LANG` decide, in that
order. A code (`ko`, `ja`, `zh`, `es`) or a name (`Korean`, `日本語`) both work. With nothing set,
or with English or `C.UTF-8`, nothing is translated.

## Settings

List them with `omp plugin config list cc-trans`. Change one with
`omp plugin config set cc-trans <key> <value>`. Each key also reads a `CC_TRANS_<NAME>` environment
variable, but only as a fallback: a stored setting wins over the variable.

| Key | Default | |
| --- | --- | --- |
| `language` | empty | your language; empty follows the system locale |
| `engine` | `haiku` | `haiku` · `openai` · `command` |
| `view` | `auto` | see the views above |
| `preview` | `true` | live English preview while typing |
| `model` | `@smol` | model for the `haiku` engine and for fallback: `provider/id`, a bare id, or a role alias |
| `openaiBaseUrl` · `openaiModel` · `openaiApiKey` | | for the `openai` engine |
| `command` | | for the `command` engine |
| `fallback` | `true` | use the model engine when `openai` or `command` fails |

### Engines

| Engine | Setup | Notes |
| --- | --- | --- |
| `haiku` (default) | none | An OMP model, chosen by `model` (default `@smol`, else the current model). The name is kept from upstream. |
| `openai` | `openaiBaseUrl`, `openaiModel`, optional `openaiApiKey` | Any OpenAI-compatible server: Ollama, LM Studio, DeepSeek, OpenRouter… |
| `command` | `command` | Your own program: `{"from","to","lines":[…]}` on stdin, `{"lines":[…]}` on stdout |

## Differences from cc-trans

| cc-trans (Claude Code) | omp-trans | Why |
| --- | --- | --- |
| `haiku` engine uses Claude Haiku | `haiku` uses an OMP model (`model`, default `@smol`) | OMP has no Haiku by default |
| Views `stacked`, `side`, `interleave`, `below`, `translated` | `interleave`, `below`, `translated`, `original` | OMP reply renderers return Markdown, so column layouts cannot be drawn |
| The sent prompt shows what you typed, with the English under it | The sent prompt shows the English; the original is saved as a `cc-trans-prompt` session entry, and a toast shows `EN ▸ …` | OMP has no renderer hook for user messages |
| Replies already on screen are translated when you resume | Only replies from the current process are translated | Resuming would otherwise send every old reply |
| Settings, queue and view persist in plugin state | Settings come from plugin config or environment; queue and view are in memory | OMP has no plugin state store |
| Language can come from Claude Code's `language` setting | Not available | OMP has no such setting |
| Replies already in your language are skipped by script share | Same, except for Latin-script languages (es, de, fr…) | Script share cannot tell English from another Latin-script language, so every English reply was skipped |

## Development

```sh
bun install
bun test
```

| Path | |
| --- | --- |
| `src/markdown.ts`, `src/engines.ts` | upstream, unchanged |
| `src/detect.ts`, `src/language.ts`, `src/strings.ts` | upstream, with the Latin-script fix and without Claude-specific text |
| `src/view.ts` | pure view helpers taken from upstream `register.tsx` |
| `src/index.ts` | the OMP adapter |

[DESIGN.md](DESIGN.md) is upstream's design note. It still names the old `hooks/` paths, which
are now under `src/`.

`bun test` runs upstream's `markdown.test.ts` plus engine, view and language tests taken from
upstream's `mod.test.tsx`. Upstream's tests for prompt submit, rendering and preview drive Claude
Code's mod harness and were not ported. That behavior was checked by running OMP 18.18.8 with the
extension.

## License

MIT. See [LICENSE](LICENSE).
