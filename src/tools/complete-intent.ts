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
 * that conflict with previously-recorded ones. Since COMPLETION_CONFLICT_DECOUPLE.md
 * these no longer block completion — the commit (status + blocks) already landed;
 * each conflicting decision is *parked* for an async disposition in the
 * Orchestration panel (supersede / keep-both / reject).
 */
export interface ConflictMatch {
  /** Stable distillation id of the proposed decision; the panel keys the disposition on it. */
  proposedDecisionId?: string
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

/**
 * A live collaborator (HAI: teammate or AI agent) whose published in-progress
 * diff overlaps the work just completed, grouped by HAI across all files
 * (Layer C completion-time collision query). Advisory awareness only — it does
 * not block completion; the overlap is exact (both sides are in the shared
 * baseline / cSHA line-space).
 */
export interface CompletionCollision {
  uid: string
  isAgent: boolean
  label: string
  files: { fpath: string, ranges: number[][] }[]
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
   * Non-empty when distillation produced decisions that contradict existing
   * standards. Since COMPLETION_CONFLICT_DECOUPLE.md the completion still
   * SUCCEEDED (success=true, status flipped, blocks captured) — these decisions
   * are *deferred*: parked for an async disposition in the Orchestration panel
   * (supersede / keep-both / reject). There is nothing to retry.
   */
  deferredConflicts?: ConflictMatch[]
  /**
   * Set when success=false to discriminate the failure mode:
   *  - "transient-failure" → distiller LLM call or /check-conflicts API errored;
   *     `failedStage` and `error` carry diagnostics, the user retries.
   */
  reason?: 'transient-failure'
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
  /**
   * Layer C completion-time collision query: live HAIs whose published diffs
   * overlap the work just completed (grouped by HAI). Present only on a
   * successful completion when at least one overlap exists. Advisory — surface
   * it to the user as a coordination heads-up; it does not affect success.
   */
  collisions?: CompletionCollision[]
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
  // `repoPath` is forwarded (not just used to derive the origin) because Muninn's
  // dispatcher reads it to trigger the agent worktree-diff publish on completion.
  // That trigger has read `data["repoPath"]` since it was written, but this payload
  // never carried the field — so it never fired once, and agent publishing was zero
  // from 2026-06-06 until W1a (kawa.muninn decision 95de7391). Muninn resolving the
  // path from the origin instead is NOT an option: with several checkouts of one
  // origin (worktree-per-intent) that lookup is first-match over a HashMap and
  // therefore non-deterministic.
  const res = await request('intent', 'complete', {
    repoOrigin: actualOrigin,
    repoPath: input.repoPath,
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
  // A completed intent ALWAYS comes back with its id — the base success payload
  // carries both `success: true` and `intentId`, with deferredConflicts /
  // apiSyncDeferred merged onto it, so those keep succeeding. A response that
  // neither declares failure nor carries an id completed nothing; reporting it
  // as success would claim a status flip, block auto-capture and distillation
  // that never happened (constraint cdb76224).
  const success = res.success !== false && !!intentId
  const deferredConflicts: ConflictMatch[] = Array.isArray(res.deferredConflicts) ? res.deferredConflicts : []
  const committedDecisionCount: number | undefined =
    typeof res.committedDecisionCount === 'number' ? res.committedDecisionCount : undefined
  const reason: 'transient-failure' | undefined =
    res.reason === 'transient-failure' ? res.reason : undefined
  const apiSyncDeferred = res.apiSyncDeferred === true
  const completionCollisions: CompletionCollision[] = Array.isArray(res.collisions) ? res.collisions : []

  // Branch on the outcome shape — pick the message that tells the agent exactly
  // what to surface to the user.
  let newStatus: string
  let message: string

  if (!success && reason === 'transient-failure') {
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
    // Catch-all for legacy / unexpected error shapes, plus the anomalous
    // "no failure declared AND no intentId" case. In the latter nothing ran,
    // so do NOT echo the requested status as though it had landed.
    newStatus = res.newStatus || res.status || (intentId ? input.status : 'active')
    message = intentId
      ? `Failed to complete intent "${intentTitle}".`
      : `Could not complete intent "${intentTitle}" — Kawa Code returned no intent id, so NOTHING was completed: the status was not changed, no code blocks were captured, and no decisions were distilled. Do NOT report this as committed. Retry complete_intent; if it fails again, surface the failure to the user rather than assuming the intent closed.`
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
    // Layer C: a live HAI's in-progress diff overlaps the work just completed.
    // Advisory coordination heads-up appended to the success message.
    const collisionPart = completionCollisions.length > 0
      ? ` — heads-up: ${completionCollisions.length} live collaborator(s) overlap this work: ` +
        completionCollisions
          .map(c => `${c.label}${c.isAgent ? ' (agent)' : ''} on ${c.files.map(f => f.fpath).join(', ')}`)
          .join('; ')
      : ''
    // COMPLETION_CONFLICT_DECOUPLE.md: distilled decisions that conflicted with
    // standards did NOT block the completion — they're parked for a disposition
    // in the Orchestration panel. Surface the count; there is nothing to retry.
    const deferredConflictPart = deferredConflicts.length > 0
      ? ` — ${deferredConflicts.length} distilled decision(s) need a disposition in the Orchestration panel (supersede / keep-both / reject)`
      : ''
    message = statusMsg + shaPart + distilledPart + deferredPart + collisionPart + deferredConflictPart
  }

  return {
    success,
    intentId,
    previousStatus,
    newStatus,
    commitSha: input.commitSha,
    message,
    committedDecisionCount,
    deferredConflicts: deferredConflicts.length > 0 ? deferredConflicts : undefined,
    reason,
    failedStage: res.failedStage,
    error: res.error,
    apiSyncDeferred: apiSyncDeferred ? true : undefined,
    deferredStages: Array.isArray(res.deferredStages) ? res.deferredStages : undefined,
    deferredDecisionCount: typeof res.deferredDecisionCount === 'number' ? res.deferredDecisionCount : undefined,
    deferredError: res.deferredError,
    collisions: completionCollisions.length > 0 ? completionCollisions : undefined,
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

REQUIRED: Inspect the response after calling this tool. Three outcomes:

1. response.success === true:
   The task is complete. Briefly acknowledge the commit and — if
   response.committedDecisionCount > 0 — mention that N distilled architectural
   decisions were recorded for the intent. Do NOT enumerate the decisions
   inline; they're visible via the orchestration panel and via
   get_intent_decisions / get_relevant_context if the user wants details.
   If response.apiSyncDeferred === true, also mention that the API sync was
   deferred; the queued writes will replay on the next sync tick.
   If response.collisions is non-empty, a live collaborator's (HAI's)
   in-progress edits overlap the work you just completed — surface it as a
   coordination heads-up (who, and which files), naming response.collisions[].label
   and the files. It's advisory, not a failure; the completion still succeeded.
   If response.deferredConflicts is non-empty, the distillation produced N
   decisions that conflict with existing standards — the completion STILL
   SUCCEEDED (the commit landed: status flipped, code blocks captured). Those
   decisions are deferred: parked for a disposition in the Orchestration panel,
   where the user picks per decision: supersede the standard, keep both (records
   a "contradicts" edge for a deliberate divergence / false positive), or reject
   the distilled decision. Tell the user "N decision(s) need a disposition in
   the panel." There is NOTHING to retry — do NOT re-run complete_intent.

2. response.success === false AND response.reason === "transient-failure":
   The distiller LLM call or the conflict-check API call errored. The
   ephemerals are preserved (the bucket is intact), and the intent stays
   "active". Tell the user the failure stage (response.failedStage) and the
   underlying error, then suggest retrying once the issue clears, or
   abandoning if the failure persists.

3. In a non-interactive (autonomous) session: if response.deferredConflicts is
   non-empty, log it at INFO and continue — the commit already landed and the
   decisions await disposition in the panel. There is no blocking state.`,
  inputSchema: completeIntentSchema,
  handler: completeIntent
}
