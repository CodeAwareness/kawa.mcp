import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

export const completeIntentSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  intentId: z.string().optional().describe('Target intent to complete/abandon. When omitted, completes THIS session\'s current intent. When provided, targets that specific intent directly — this is how you force-close an intent that is not your current one (e.g. another session\'s). Completing an intent created by ANOTHER team member additionally requires humanApproved=true (see below).'),
  commitSha: z.string().optional().describe('The git commit SHA to associate with this intent (if already committed)'),
  status: z.enum(['committed', 'pushed', 'done', 'abandoned', 'superseded']).default('committed')
    .describe('The new status for the intent. Use "committed" after git commit, "done" when work is complete, "abandoned" to discard, "superseded" when another intent replaces this one.'),
  supersededBy: z.string().optional().describe('Intent ID that supersedes this one. Required when status is "superseded".'),
  humanApproved: z.boolean().optional().describe('Set to true ONLY when the human has explicitly confirmed closing an intent created by ANOTHER team member. Required for that cross-author case; ignored for your own intents. NEVER set this on your own initiative — always ask the user first and only set it after they approve.'),
  ...forkFieldsExtensions,
})

export type CompleteIntentInput = z.infer<typeof completeIntentSchema>

/**
 * One contradiction between a distilled proposed decision and an existing
 * standard decision in the repo. Surfaced when distillation produces decisions
 * that conflict with previously-recorded ones (PRD §5.2 step 5b / §7.2).
 */
export interface ConflictMatch {
  proposedDecisionSummary: string
  proposedDecisionRationale: string
  conflictsWith: {
    decisionId: string
    summary: string
    intentTitle?: string
    author?: string
  }
  sharedConcern?: string
  description?: string
}

export interface CompleteIntentResponse {
  success: boolean
  intentId: string
  previousStatus: string
  /**
   * The status after this call. Stays "active" when distillation surfaces
   * conflicts (PRD §5.2 step 5b — no decisions written, no transition).
   */
  newStatus: string
  commitSha?: string
  message: string
  /**
   * Number of distilled standard decisions written to the API on a clean
   * completion. Omitted when there were no ephemerals, when the v2 pipeline
   * is disabled, or when conflicts blocked the write.
   *
   * Decision *content* is intentionally not surfaced here — it's already
   * visible via the orchestration panel and via get_intent_decisions /
   * get_relevant_context. Inlining the full list would just duplicate that
   * channel and add noise to the agent's reply.
   */
  committedDecisionCount?: number
  /**
   * Non-empty when the proposed-decision distillation contradicted existing
   * standard decisions. Each entry pairs the proposed decision with the
   * specific standard decision it contradicts, so the agent can surface the
   * pair to the user. When conflicts is non-empty, success=false and
   * newStatus stays "active" — the user resolves and retries.
   */
  conflicts?: ConflictMatch[]
  /**
   * Set when success=false to discriminate between:
   *  - "conflicts" → see `conflicts[]`
   *  - "transient-failure" → distiller LLM call or /check-conflicts API errored;
   *     `failedStage` and `error` carry diagnostics, the user retries.
   */
  reason?: 'conflicts' | 'transient-failure'
  failedStage?: string
  error?: string
  /**
   * Phase 3.5 — true when an API write call (decisions/sync, intents/PATCH)
   * was queued for later replay because the API was unreachable. Work is
   * "done" from the user's perspective; surface a heads-up. `deferredStages`
   * names which write(s) were queued.
   */
  apiSyncDeferred?: boolean
  deferredStages?: string[]
  deferredDecisionCount?: number
  deferredError?: string
}

export async function completeIntent(input: CompleteIntentInput): Promise<CompleteIntentResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)

  // Multi-active model (IMPLEMENTATION_PLAN_MULTI_ACTIVE_INTENTS.md §7): `intentId`
  // is a TARGET, forwarded to Muninn directly. When omitted, Muninn completes this
  // session's current pointer; when provided, it targets that specific intent
  // (force-close). There is no per-repo single "active" intent to verify against
  // anymore, so the old get-active match-or-reject guard is gone. The same-user vs
  // cross-user authorization (and the humanApproved requirement for closing a
  // teammate's intent) is hard-enforced API-side.

  // Muninn's v2 distillation pipeline (Sonnet distill + per-pair Haiku conflict
  // judge + recall embeddings) can run well past the 30s default — measured
  // 51s for superseded on an M3 (see kawa.muninn intent.rs). Override the
  // per-call timeout so conflict / transient-failure responses actually come
  // back instead of the client hanging up first. Mirrors inference:estimate's
  // ESTIMATE_TIMEOUT_MS (decision 092172fb: per-call override, not a raised global).
  const COMPLETE_TIMEOUT_MS = 180_000
  const res = await request('intent', 'complete', {
    repoOrigin: actualOrigin,
    intentId: input.intentId,
    status: input.status,
    commitSha: input.commitSha,
    supersededBy: input.supersededBy,
    humanApproved: input.humanApproved,
    ...extractForkFields(input),
  }, COMPLETE_TIMEOUT_MS)

  const intentId = res.intentId || ''
  const intentTitle = res.intentTitle || 'Intent'
  const previousStatus = res.previousStatus || 'active'
  const success = res.success !== false
  const conflicts: ConflictMatch[] = Array.isArray(res.conflicts) ? res.conflicts : []
  const committedDecisionCount: number | undefined =
    typeof res.committedDecisionCount === 'number' ? res.committedDecisionCount : undefined
  const reason: 'conflicts' | 'transient-failure' | undefined =
    res.reason === 'conflicts' || res.reason === 'transient-failure' ? res.reason : undefined
  const apiSyncDeferred = res.apiSyncDeferred === true

  // Branch on the four §7.2 / §7.3 outcome shapes — pick the message that
  // tells the agent exactly what to surface to the user.
  let newStatus: string
  let message: string

  if (!success && reason === 'conflicts') {
    // PRD §5.2 step 5b — distilled decisions contradicted standards. No write,
    // no transition, bucket preserved. The agent's job is to surface each
    // conflict to the user and ask how to resolve.
    newStatus = res.status || 'active'
    const lines: string[] = [
      `Cannot complete: ${conflicts.length} conflict(s) between proposed decisions and existing standards.`,
      '',
      'For each conflict below, surface BOTH sides side-by-side to the user and ask how to resolve.',
      'Common resolution paths:',
      '  (A) Record a superseding decision: record_decision(type="fork", supersedes=["<existing-decision-id>"], rationale=...). Then retry complete_intent.',
      '  (B) Abandon the intent: complete_intent(status="abandoned"). Decisions are soft-deleted but recoverable via activate_intent.',
      '  (C) Keep the intent active and continue working.',
      '',
      'DO NOT silently retry — every retry runs the distiller again and produces the same conflicts.',
      '',
    ]
    conflicts.forEach((c, i) => {
      lines.push(`[${i + 1}] Proposed: ${c.proposedDecisionSummary}`)
      const cw = c.conflictsWith || ({} as ConflictMatch['conflictsWith'])
      const author = cw.author ? ` by ${cw.author}` : ''
      const intentPart = cw.intentTitle ? ` (intent: "${cw.intentTitle}")` : ''
      lines.push(`    Conflicts with: ${cw.summary || cw.decisionId || '(unknown)'}${intentPart}${author}`)
      if (c.description) lines.push(`    ${c.description}`)
      lines.push('')
    })
    message = lines.join('\n')
  } else if (!success && reason === 'transient-failure') {
    // Distiller LLM error or /check-conflicts API error. Bucket re-populated,
    // intent stays active. User decides whether to wait + retry or abandon.
    newStatus = res.status || 'active'
    const stage = res.failedStage ? ` (${res.failedStage})` : ''
    const errPart = res.error ? `: ${res.error}` : ''
    message =
      `Could not complete intent "${intentTitle}" — transient failure${stage}${errPart}. ` +
      `The ephemerals were preserved. Wait for the underlying issue to clear, then retry complete_intent. ` +
      `If retrying repeatedly fails, the user can abandon the intent (complete_intent(status="abandoned")).`
  } else if (!success) {
    // Catch-all for legacy / unexpected error shapes.
    newStatus = res.newStatus || res.status || input.status
    message = `Failed to complete intent "${intentTitle}".`
  } else {
    // Clean completion. Note: Phase 3.5 may have queued writes for later
    // replay — the response is success=true but apiSyncDeferred=true.
    newStatus = res.newStatus || input.status
    const statusMessages: Record<string, string> = {
      committed: `Intent "${intentTitle}" marked as committed`,
      pushed: `Intent "${intentTitle}" marked as pushed`,
      done: `Intent "${intentTitle}" marked as done`,
      abandoned: `Intent "${intentTitle}" abandoned`,
      superseded: `Intent "${intentTitle}" marked as superseded`,
    }
    const statusMsg = statusMessages[input.status] || `Intent "${intentTitle}" updated`
    const shaPart = input.commitSha ? ` (commit: ${input.commitSha.substring(0, 7)})` : ''
    const distilledPart = committedDecisionCount && committedDecisionCount > 0
      ? ` — ${committedDecisionCount} distilled decision(s) recorded`
      : ''
    const deferredPart = apiSyncDeferred
      ? ` — API sync deferred (${(res.deferredStages || []).join(', ')}); will retry on the next sync tick`
      : ''
    message = statusMsg + shaPart + distilledPart + deferredPart
  }

  return {
    success,
    intentId,
    previousStatus,
    newStatus,
    commitSha: input.commitSha,
    message,
    committedDecisionCount,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    reason,
    failedStage: res.failedStage,
    error: res.error,
    apiSyncDeferred: apiSyncDeferred ? true : undefined,
    deferredStages: Array.isArray(res.deferredStages) ? res.deferredStages : undefined,
    deferredDecisionCount: typeof res.deferredDecisionCount === 'number' ? res.deferredDecisionCount : undefined,
    deferredError: res.deferredError,
  }
}

export const completeIntentTool = {
  name: 'complete_intent',
  description: `Mark the active intent as completed and clear it.

Call this after a successful git commit to:
1. Update the intent status (committed/pushed/done/abandoned)
2. Store the commit SHA for tracking
3. Clear the active intent so a new one can be started

Status values:
- "committed": Code is committed locally (default)
- "pushed": Code has been pushed to remote
- "done": Work is fully complete
- "abandoned": Work was discarded without committing

REQUIRED: Inspect the response after calling this tool. Four outcomes:

1. response.success === true:
   The task is complete. Briefly acknowledge the commit and — if
   response.committedDecisionCount > 0 — mention that N distilled architectural
   decisions were recorded for the intent. Do NOT enumerate the decisions
   inline; they're visible via the orchestration panel and via
   get_intent_decisions / get_relevant_context if the user wants details.
   If response.apiSyncDeferred === true, also mention that the API sync was
   deferred; the queued writes will replay on the next sync tick.

2. response.success === false AND response.conflicts is non-empty:
   The distillation produced decisions that contradict existing standards in
   this repo. Status stays "active" and NO decisions were written.
   Surface EACH conflict to the user with the proposed decision and the
   conflicting standard decision side-by-side. Then ask the user how to
   resolve. Common options to suggest:
     (A) Record a superseding decision via record_decision(type="fork",
         supersedes=["<existing-decision-id>"], rationale=...). Then retry
         complete_intent — the distiller may now find the new superseding
         decision in recall and the conflict resolves.
     (B) Abandon the intent: complete_intent(status="abandoned"). Decisions
         are soft-deleted but recoverable via activate_intent if the user
         changes their mind.
     (C) Keep the intent active and continue working.
   DO NOT silently retry — every retry runs the distiller (and the per-pair
   judge) again. Wait for the user's decision.

3. response.success === false AND response.reason === "transient-failure":
   The distiller LLM call or the conflict-check API call errored. The
   ephemerals are preserved (the bucket is intact), and the intent stays
   "active". Tell the user the failure stage (response.failedStage) and the
   underlying error, then suggest retrying once the issue clears, or
   abandoning if the failure persists.

4. In a non-interactive (autonomous) session: log the conflicts at WARN level
   and leave the intent active. A human review path exists via the panel.`,
  inputSchema: completeIntentSchema,
  handler: completeIntent
}
