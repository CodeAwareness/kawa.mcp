/**
 * Context-injection telemetry (VALUE_METRICS.md Phase 2, Track B).
 *
 * At each of the 5 injection points where Kawa adds context to an agent's turn,
 * we SIZE the payload we're about to inject (≈ chars/4 tokens) and emit a
 * fire-and-forget IPC to Muninn, which forwards it to kawa.api. This is the COST
 * side of the headline ratio ("Kawa adds ≈N tokens/turn"), paired with an
 * "acted on" signal for the benefit side.
 *
 * Keep-mcp-thin: this module ONLY sizes + hashes + forwards. No storage, no API
 * client, no business logic — Muninn owns the forward and the API owns the
 * store. Every emit is fire-and-forget and swallows its own errors, so telemetry
 * can never block or fail a tool call or a hook.
 *
 * Zero-knowledge: we emit token COUNTS, item COUNTS, and opaque decision ids
 * only — never the strings measured. The repo origin is HASHED here before it
 * leaves the process (`hashOrigin`, byte-identical to
 * kawa.api/scripts/value-report.ts so `--repo` filtering matches).
 */

import * as crypto from 'node:crypto'

import { request, SESSION_ID } from './services/muninn-ipc.js'

/** Coarse char→token approximation; deterministic, no tokenizer dep. Matches
 *  CHARS_PER_TOKEN in kawacode-on-pre-edit.ts and the "≈ chars/4" method the
 *  value-report publishes. */
const CHARS_PER_TOKEN = 4

export type InjectionType = 'recall' | 'pre_edit' | 'stop_gate' | 'stop_collision' | 'check_active'

/** ≈ tokens for a string payload (chars/4, rounded up). Labelled "≈" wherever published. */
export function estimateTokens(s: string | undefined | null): number {
  return Math.ceil((s ? s.length : 0) / CHARS_PER_TOKEN)
}

/**
 * Hash a repo origin for the zero-knowledge aggregate. MUST stay byte-identical
 * to `hashOrigin` in kawa.api/scripts/value-report.ts (which hashes the
 * lowercased origin) so a `--repo <origin>` filter matches these rows. Callers
 * pass the lowercased origin.
 */
export function hashOrigin(origin: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(origin || '').digest('hex').slice(0, 16)
}

function enabled(): boolean {
  return process.env.KAWA_VALUE_TELEMETRY !== 'off'
}

/** ISO timestamp (informational; the API windows on its own _c). */
function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Emit one context-injection sizing. Fire-and-forget: returns a resolved
 * promise even on failure. Callers in the long-lived server may ignore the
 * result; hook callers should include it in their pre-disconnect await set so
 * the socket write flushes before the process exits.
 */
export function emitInjection(args: {
  type: InjectionType
  tokensEst: number
  itemCount: number
  /** raw repo origin — hashed here before it leaves the process */
  repoOrigin: string
  /** recall only — surfaced decision ids, for the read-side recall→supersedes join */
  decisionIds?: string[]
}): Promise<void> {
  if (!enabled()) return Promise.resolve()
  const data: Record<string, any> = {
    type: args.type,
    tokensEst: args.tokensEst,
    itemCount: args.itemCount,
    sessionId: SESSION_ID,
    repoOriginHash: hashOrigin((args.repoOrigin || '').toLowerCase()),
    ts: nowIso(),
  }
  if (args.decisionIds && args.decisionIds.length) data.decisionIds = args.decisionIds
  return request('telemetry', 'record', data).then(() => {}).catch(() => {})
}

/**
 * Emit one "acted on" signal (R2 acted-on rate; V8 gate-saves when
 * type='stop_gate'). Fire-and-forget.
 */
export function emitActedOn(args: {
  type: InjectionType
  /** the surfaced id that was used (e.g. a decisionId) */
  refId?: string
  repoOrigin: string
}): Promise<void> {
  if (!enabled()) return Promise.resolve()
  const data: Record<string, any> = {
    type: args.type,
    sessionId: SESSION_ID,
    repoOriginHash: hashOrigin((args.repoOrigin || '').toLowerCase()),
    ts: nowIso(),
  }
  if (args.refId) data.refId = args.refId
  return request('telemetry', 'acted_on', data).then(() => {}).catch(() => {})
}

/**
 * Close the telemetry turn for this session (Stop hook). Muninn OWNS turnSeq and
 * stamps the real turnId on injections; this signal just tells it the turn ended
 * so the NEXT injection opens a fresh turnId. Keep-mcp-thin: no seq/state here.
 *
 * MUST be sent AFTER this turn's stop_gate/stop_collision injections have flushed
 * so they attribute to the closing turn — the Stop hook awaits those emits first.
 * No body needed: muninn-ipc stamps `_agentId = SESSION_ID`, which Muninn resolves
 * to the same session key the injections used. Fire-and-forget.
 */
export function emitTurnEnd(): Promise<void> {
  if (!enabled()) return Promise.resolve()
  return request('telemetry', 'turn_end', {}).then(() => {}).catch(() => {})
}
