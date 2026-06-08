import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

/**
 * Thin proxy to Muninn's `pre-edit-check:resolution-context` handler (Layer C,
 * Phase 2 — proactive pre-edit conflict resolution).
 *
 * Two-call protocol:
 *   1. DETECT (cheap, once per turn) — the Stop hook surfaces a live-HAI
 *      collision report (per-peer `uid` + overlapping file ranges) when a peer
 *      is editing the same lines this turn. (Detection was relocated off the
 *      per-edit pre_edit_decision_check to the Stop hook —
 *      COLLISION_SURFACE_RELOCATION.md.)
 *   2. RESOLVE (expensive, opt-in) — for a peer surfaced in that report, call
 *      THIS tool with their `uid` + ranges. Muninn decrypts the peer's
 *      overlapping diff (it holds the repo key; the API only stores ciphertext)
 *      and returns it + the file's recorded decisions + a guardrail policy, so
 *      you can adapt.
 *
 * All assembly + the encryption boundary live in Muninn. This tool only
 * validates input, resolves the origin, and forwards the request.
 */

export const getResolutionContextSchema = z.object({
  repoOrigin: z
    .string()
    .optional()
    .describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z
    .string()
    .describe('Local path to the repository root'),
  peerUid: z
    .string()
    .describe('The peer HAI whose live edits overlap — the `uid` of a collision from the Stop hook collision report.'),
  filePath: z
    .string()
    .describe('Path to the file being edited (relative to repoPath)'),
  ranges: z
    .array(z.array(z.number()))
    .describe('Overlapping [start, end] line ranges (from the collision) to fetch the peer code for.'),
  intentId: z
    .string()
    .optional()
    .describe('Active intent ID (advisory). Auto-detected by Kawa Code when omitted.'),
  ...forkFieldsExtensions,
})

export type GetResolutionContextInput = z.infer<typeof getResolutionContextSchema>

export interface ResolutionRangeSnippet {
  range: number[]
  lines: string[]
}

export interface ResolutionGuardrail {
  triggerConfidence: number
  rule_committed: string
  reversibility: string
  mustRecord: string
  weidner: string
}

export interface GetResolutionContextResponse {
  peer: { uid: string; label: string; sha?: string }
  filePath: string
  ranges: number[][]
  baselineSha?: string
  /** True when the peer's live diff for this file was found and decrypted. */
  peerDiffAvailable: boolean
  /** The peer's reconstructed code at each overlapping range. */
  peerSnippet: ResolutionRangeSnippet[]
  /** File-scoped recorded decisions (region context; not peer-uid filtered). */
  decisions: any[]
  /** Deferred until an intents-by-file endpoint exists (see `note`). */
  peerIntents: any[]
  note?: string
  guardrail: ResolutionGuardrail
}

export async function getResolutionContext(
  input: GetResolutionContextInput,
): Promise<GetResolutionContextResponse> {
  const repoOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const forkFields = extractForkFields(input)

  const res = await request('pre-edit-check', 'resolution-context', {
    repoOrigin,
    repoPath: input.repoPath,
    peerUid: input.peerUid,
    filePath: input.filePath,
    ranges: input.ranges,
    intentId: input.intentId,
    ...forkFields,
  })

  return res as GetResolutionContextResponse
}

export const getResolutionContextTool = {
  name: 'get_resolution_context',
  description: `Resolve a live code collision with a peer BEFORE you write (Layer C resolution handoff).

Call this when the Stop hook's collision report (or complete_intent's resolution_required gate) surfaced a live peer (a teammate or AI agent editing the same lines). Pass that collision's uid as peerUid and its overlapping ranges. You get back:
- peerSnippet — the peer's actual (decrypted) code at the overlapping lines, so you can see what they wrote.
- decisions — recorded reasoning attached to this file (region context).
- guardrail — the policy you must follow when resolving:
  • Never overwrite a peer's COMMITTED work — yield or merge. Only override an uncommitted live diff, and only with a recorded rationale.
  • Your resolution is an ordinary git edit (revert/diff is the undo) — stay in your own working tree; build no bespoke undo.
  • Before completing, record_decision(type=fork|tradeoff, …) explaining how you resolved (and supersedes the peer's decision if you overrode it).
  • Choose or synthesize ONE coherent result — never blindly interleave both diffs.

This is advisory and proactive (no lock). Use it to adapt your edit and avoid the conflict.`,
  inputSchema: getResolutionContextSchema,
  handler: getResolutionContext,
}
