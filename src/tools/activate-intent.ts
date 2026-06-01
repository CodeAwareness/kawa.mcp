import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

export const activateIntentSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  intentId: z.string().describe('The cloud ID (preferred) or local UUID of the existing intent to activate.'),
  ...forkFieldsExtensions,
})

export type ActivateIntentInput = z.infer<typeof activateIntentSchema>

export interface ActivateIntentResponse {
  success: boolean
  intentId: string
  action?: 'activated' | 'already_active'
  previousActiveId?: string
  message: string
}

export async function activateIntent(input: ActivateIntentInput): Promise<ActivateIntentResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)

  // This session's current focus before the switch.
  const activeRes = await request('intent', 'get-active', { repoOrigin: actualOrigin })
  const previousActiveId = activeRes.intentId || activeRes.intent?.id || ''

  if (previousActiveId === input.intentId) {
    return {
      success: true,
      intentId: input.intentId,
      action: 'already_active',
      previousActiveId,
      message: `Intent ${input.intentId.substring(0, 8)} is already your current intent`,
    }
  }

  // Move THIS session's `current` pointer to the target intent. Under the
  // multi-active model (no lock) this never conflicts — other sessions keep
  // their own current pointers, and the API holds the full active set.
  await request('intent', 'set-active', {
    repoOrigin: actualOrigin,
    intentId: input.intentId,
    ...extractForkFields(input),
  })

  return {
    success: true,
    intentId: input.intentId,
    action: 'activated',
    previousActiveId: previousActiveId || undefined,
    message: previousActiveId
      ? `Switched current intent to ${input.intentId.substring(0, 8)} (was: ${previousActiveId.substring(0, 8)})`
      : `Activated intent ${input.intentId.substring(0, 8)}`,
  }
}

export const activateIntentTool = {
  name: 'activate_intent',
  description: `Activate an existing intent by ID — sets it as THIS session's current focus.

Use this to:
- Switch your current focus to a different intent found via list_team_intents or get_relevant_context
- Re-activate an intent that was deactivated (e.g., to complete it)
- Resume work on a previously created intent
- Resume an "abandoned" or "pending" intent (see below)

Accepts both cloud IDs (from get_relevant_context / API) and local UUIDs (from list_team_intents).

Multi-active model: activating an intent only moves YOUR session's current
pointer. Many intents can be active on a repo at once (one current per
session/teammate), so this never blocks on or displaces another session's
active intent — there is no lock to take over.

Resuming abandoned / pending intents:
- Abandoned intents have their decisions soft-deleted (invisible to recall and
  get_relevant_context). Activating one transparently restores them — single-intent
  decisions for this intent get their soft-delete cleared so the prior reasoning
  becomes visible again. Multi-intent decisions stay visible throughout (they were
  never soft-deleted).
- Pending intents are intents auto-finalized by the orphan-recovery sweeper (24h
  inactivity) — possibly with conflicts blocking the finalization. Their decisions
  were never soft-deleted, so activating one is a clean resume; new ephemerals
  accumulate in a fresh bucket and the next complete_intent distills only the new work.`,
  inputSchema: activateIntentSchema,
  handler: activateIntent,
}
