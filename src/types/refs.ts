/**
 * Entity references — the shapes that carry a human-readable label alongside
 * an id, so no tool response hands the model an id it cannot name.
 *
 * Workstream 1 of `kawa.dev-doc/DECISION_LINKING.md`. Before this, every
 * reference reaching a human was a bare 8-char hex prefix:
 *
 *     7a7d1a36 supersedes 2cc444ec, which superseded 97c701e7
 *
 * Three ids, zero information. Naming a single ancestor cost an extra
 * `get_decision_detail` round trip *per ancestor*, so it never happened.
 * Kawa Code resolves the labels now and hands them over pre-joined.
 *
 * These refs carry **identity only** — never rationale, context or
 * consequences. That is deliberate: recall payloads are kept lean, and a
 * summary is bounded (~100 chars) and *is* the identity of the thing. If one of
 * these ever grows a `rationale` field, that is the regression.
 */

/** A decision, named. */
export interface DecisionRef {
  id: string
  summary: string
  type: string
  /**
   * Distance along a supersession chain: 1 is a direct ancestor, 2 is what
   * *that* one superseded, and so on.
   *
   * Present because order alone is ambiguous once a `supersedes` array is wider
   * than one — without it there is no way to tell "A supersedes B and C" from
   * "A supersedes B, which superseded C".
   */
  depth?: number
}

/**
 * An intent, named.
 *
 * `id` is always the **full 24-character** ObjectId, never a prefix. Intent ids
 * are Mongo ObjectIds whose leading 4 bytes are a Unix timestamp, so two
 * intents created by the same process in the same second share their first 18
 * hex characters. A truncated intent id is not merely collision-prone — it is
 * not resolvable to a single intent at all. Decision ids are UUIDs and do not
 * have this problem; an 8-char decision prefix is unambiguous.
 */
export interface IntentRef {
  id: string
  title: string
  status: string
}

/** Shape Kawa Code returns for a resolved reference. Tolerant of an absent label. */
type RawRef = Record<string, unknown> | null | undefined

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Normalize one decision ref off an IPC payload.
 *
 * Returns `null` rather than a half-built ref when there is no id or summary —
 * an unlabelled reference is not a ref, and callers fall back to the bare id,
 * which is exactly the pre-W1 behaviour. Label resolution is fail-soft end to
 * end: an unresolvable ancestor must never turn a working response into an error.
 */
export function toDecisionRef(raw: RawRef): DecisionRef | null {
  if (!raw) return null
  const id = str(raw.id) || str(raw.decisionId)
  const summary = str(raw.summary)
  if (!id || !summary) return null
  const depth = typeof raw.depth === 'number' ? raw.depth : undefined
  return { id, summary, type: str(raw.type) || str(raw.decisionType), depth }
}

/** Normalize one intent ref off an IPC payload. Same fail-soft contract. */
export function toIntentRef(raw: RawRef): IntentRef | null {
  if (!raw) return null
  const id = str(raw.id) || str(raw.intentId)
  const title = str(raw.title)
  if (!id || !title) return null
  return { id, title, status: str(raw.status) }
}

export function toDecisionRefs(raw: unknown): DecisionRef[] {
  if (!Array.isArray(raw)) return []
  return raw.map(toDecisionRef).filter((r): r is DecisionRef => r !== null)
}

export function toIntentRefs(raw: unknown): IntentRef[] {
  if (!Array.isArray(raw)) return []
  return raw.map(toIntentRef).filter((r): r is IntentRef => r !== null)
}

/**
 * How to name an entity in a message.
 *
 * Leads with the label and keeps the id in parentheses, per the prose
 * convention in LLM_RULES.md. Falls back to the bare id when nothing resolved,
 * which is the whole point of the fail-soft contract above.
 */
export function nameDecision(ref: DecisionRef | null, fallbackId: string): string {
  return ref ? `"${ref.summary}" (${ref.id})` : fallbackId
}

export function nameIntent(ref: IntentRef | null, fallbackId: string): string {
  return ref ? `"${ref.title}" (${ref.id})` : fallbackId
}
