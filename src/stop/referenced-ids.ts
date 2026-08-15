/**
 * Harvest entity references out of the session transcript (DECISION_LINKING §6.8A).
 *
 * Two sets, both from one read of the file:
 *
 *  - `candidates` — hex tokens the agent WROTE in this turn's prose. Typically
 *    8-char decision prefixes and full 24-char intent ids.
 *  - `knownFull`  — full-form ids appearing in kawa TOOL RESULTS anywhere in the
 *    session. The entities this session has demonstrably handled.
 *
 * `knownFull` is a prefix→full-id disambiguator, not a source of labels; Muninn
 * resolves labels from its own memo. Sending tokens rather than prose also keeps
 * the payload tiny and avoids shipping the assistant's output over IPC.
 *
 * # Why "this turn", not "the last assistant message"
 *
 * The design said to read the last assistant message. Verified against a real
 * transcript, that is wrong: ONE turn produces many `type: "assistant"` lines —
 * one per tool call — so the final line usually holds a single trailing
 * sentence. In a 415-assistant-line transcript only 79 lines carried text at
 * all. Reading just the last one would silently miss most of what the agent
 * wrote, and the failure would look like an under-populated panel rather than a
 * bug.
 *
 * A turn is therefore delimited by the last REAL user message — one the human
 * typed, not the synthetic `user` messages that carry `tool_result` blocks back
 * to the model.
 *
 * # Git short SHAs
 *
 * Not filtered, because they cannot be: a short SHA and a truncated decision id
 * are the same shape. They are eliminated downstream by resolution — a SHA names
 * no decision, so it resolves to nothing and never reaches the panel.
 */

/** Full UUID, or any hex run of 8+ characters (covers 24-char ObjectIds and
 *  8-char prefixes alike). UUID first: alternation order decides which wins. */
const ID_LIKE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{8,}\b/gi

/** A tool whose results are worth harvesting full ids from. */
function isKawaTool(name: string): boolean {
  return /kawa/i.test(name)
}

/** Flatten a content item's text payload to a plain string. */
function itemText(item: any): string {
  if (typeof item?.text === 'string') return item.text
  const c = item?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
  }
  return ''
}

/**
 * True for a message that represents the human speaking.
 *
 * `tool_result` blocks come back as `user` messages too, so role alone cannot
 * delimit a turn. A real prompt carries a string content, or an array with a
 * `text` block in it.
 */
function isRealUserMessage(obj: any): boolean {
  if (obj?.type !== 'user') return false
  const content = obj?.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((it: any) => it?.type === 'text' && typeof it.text === 'string')
}

export interface Harvest {
  /** Hex tokens the agent wrote this turn. */
  candidates: string[]
  /** Full-form ids seen in kawa tool results, this session. */
  knownFull: string[]
  /** The session's first user request, used as a group label when the session
   *  has no intent — the only label some repos will ever show. */
  firstRequest: string
}

/**
 * Scan a transcript once and return both sets plus the session's opening ask.
 */
export function harvestReferences(transcriptText: string): Harvest {
  const lines = transcriptText.split('\n')

  // Pass 1 — locate this turn, remember tool names, and collect tool results.
  let turnStart = 0
  let firstRequest = ''
  const kawaToolUseIds = new Set<string>()
  const resultsByToolUseId = new Map<string, string>()

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (!ln) continue
    let obj: any
    try {
      obj = JSON.parse(ln)
    } catch {
      continue
    }

    if (isRealUserMessage(obj)) {
      turnStart = i
      if (!firstRequest) {
        const content = obj.message.content
        const text =
          typeof content === 'string'
            ? content
            : content.find((it: any) => it?.type === 'text')?.text || ''
        firstRequest = text.replace(/\s+/g, ' ').trim().slice(0, 120)
      }
    }

    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      if (item?.type === 'tool_use' && item.id && isKawaTool(item.name || '')) {
        kawaToolUseIds.add(item.id)
      } else if (item?.type === 'tool_result' && item.tool_use_id) {
        resultsByToolUseId.set(item.tool_use_id, itemText(item))
      }
    }
  }

  // Pass 2 — the current turn's assistant prose. `thinking` blocks are excluded
  // deliberately: the panel reflects what the agent SAID, and the user never saw
  // the reasoning trace as an answer.
  const written: string[] = []
  for (let i = turnStart; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (!ln) continue
    let obj: any
    try {
      obj = JSON.parse(ln)
    } catch {
      continue
    }
    if (obj?.type !== 'assistant') continue
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string') written.push(item.text)
    }
  }

  const candidates = dedupe(matchIds(written.join('\n')))

  // Full ids from kawa tool results only. A full id is one that needs no
  // disambiguation, so prefixes found here are of no use and are dropped.
  const knownFull = dedupe(
    [...kawaToolUseIds]
      .map((id) => resultsByToolUseId.get(id) || '')
      .flatMap((text) => matchIds(text))
      .filter(isFullId),
  )

  return { candidates, knownFull, firstRequest }
}

function matchIds(text: string): string[] {
  if (!text) return []
  return (text.match(ID_LIKE) || []).map((s) => s.toLowerCase())
}

/** A full id: canonical UUID (decision) or 24 hex characters (intent ObjectId). */
export function isFullId(token: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token) ||
    /^[0-9a-f]{24}$/.test(token)
  )
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
