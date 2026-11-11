export type View = 'auto' | 'stacked' | 'interleave' | 'side' | 'below' | 'translated' | 'original'

/** One reply block's translation, keyed by a hash of the block's text. */
export type ReplyEntry = {
  status: 'pending' | 'done' | 'failed' | 'skipped'
  /** Restored translations per unit of planMarkdown(text); null where a unit failed. */
  out: (string | null)[]
  engine: string
  error?: string
}

/** A prompt the person typed, and the English the model reads instead. */
export type PromptEntry = { native: string; english: string; engine: string }
