import { z } from 'zod'
import { request, MuninnTimeoutError } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'

export const createAndActivateIntentSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  title: z.string().max(200).describe('Short, descriptive title for the intent'),
  description: z.string().max(2000).describe('What this intent accomplishes'),
  templateType: z.enum(['feature', 'refactor', 'exploration']).default('feature').describe('Type of work'),
  constraints: z.array(z.string()).optional().describe('Requirements or constraints for this work'),
  pendingId: z.string().optional().describe(
    'Only after a pending_approval response: the pendingId it returned. Asks whether the user has decided. Pass the same title, description and repoPath as before.',
  ),
})

export type CreateIntentInput = z.infer<typeof createAndActivateIntentSchema>

export type CreateIntentAction =
  | 'created'
  | 'reactivated'
  | 'pending_approval'
  | 'awaiting_user'
  | 'declined'
  | 'expired'
  | 'unknown_pending'

export interface CreateIntentResponse {
  success: boolean
  intentId: string
  action: CreateIntentAction
  /** Present while the request is parked in Kawa Code. */
  pendingId?: string
  /** How many more times the user's decision may be checked before waiting for them. */
  pollsLeft?: number
  message: string
}

/**
 * How long one tool call waits for the user's decision. A WALL-CLOCK budget, not a
 * count of status calls: each status call is bounded by what is left of it, so the
 * deadline holds even when Kawa Code is busy. 20 s sits well inside every Claude
 * Code tool-call limit (hours; auto-background at 2 min) and inside the 30 s IPC
 * default.
 */
export const WAIT_BUDGET_MS = 20_000
/** Pause between status calls. */
export const POLL_INTERVAL_MS = 1_000
/** The IPC default; a status call never gets more than this. */
export const MAX_STATUS_CALL_MS = 30_000
/** Below this, another status call cannot usefully finish: stop and report. */
export const MIN_STATUS_CALL_MS = 250

/** The side effects, injected so the loop is testable without Muninn or a clock. */
export interface CreateIntentDeps {
  request: (domain: string, action: string, data?: any, timeoutMs?: number) => Promise<any>
  now: () => number
  sleep: (ms: number) => Promise<void>
  resolveOrigin: (repoOrigin: string | undefined, repoPath: string) => string
}

const liveDeps: CreateIntentDeps = {
  request,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  resolveOrigin,
}

export async function createAndActivateIntent(input: CreateIntentInput): Promise<CreateIntentResponse> {
  return createIntentFlow(input, liveDeps)
}

/**
 * Forward the request to Kawa Code and relay the outcome. No state, no cache: the
 * parked request, the owner's answer and the poll cap all live in Kawa Code.
 *
 * Deliberately a plain forward-and-wait. The wait is here, not in Kawa Code,
 * because Kawa Code runs one request at a time: a handler that waited would stall
 * every other session's calls.
 */
export async function createIntentFlow(input: CreateIntentInput, deps: CreateIntentDeps): Promise<CreateIntentResponse> {
  // `force` is gone (hard cut). Only the owner, in Kawa Code, can decide to
  // proceed past an overlap. A client holding a stale schema must be told, not
  // silently ignored: it believes it asked to bypass the check.
  if ((input as { force?: unknown }).force === true) {
    throw new Error(
      '`force` is no longer accepted. If the new intent overlaps existing work, Kawa Code asks the user to decide; ' +
      'call create_and_activate_intent again without `force`.',
    )
  }

  const origin = deps.resolveOrigin(input.repoOrigin, input.repoPath)

  if (input.pendingId) {
    return waitForDecision(origin, input.pendingId, deps)
  }

  // Create. If a sufficiently similar intent created by THIS session already
  // exists, the server may reactivate it instead of creating a duplicate; two
  // sessions' near-duplicates are surfaced as an overlap, not merged.
  const createRes = await deps.request('intent', 'create', {
    repoOrigin: origin,
    title: input.title,
    description: input.description,
    templateType: input.templateType,
    constraints: input.constraints || [],
    scope: { type: 'repo', paths: [] },
  })

  // Overlap: Kawa Code parked the request for the user. NOTHING about the
  // overlapping intents is relayed here beyond a count — the API fills each one's
  // `author` with a display name, and the card in Kawa Code is where the user
  // reads the detail.
  if (createRes.action === 'pending_approval') {
    const count = typeof createRes.conflictCount === 'number' ? createRes.conflictCount : 0
    return pendingApproval(createRes.pendingId, undefined, count)
  }

  // Propagate Muninn-side errors (e.g. not signed in, API unreachable) to the AI
  // so it can tell the user how to recover instead of silently proceeding.
  if (createRes.success === false) {
    throw new Error(createRes.error || 'Intent creation failed')
  }

  const intentId = createRes.intent?.id || createRes.intentId || ''
  if (!intentId) {
    throw new Error('Intent creation succeeded but no intent ID was returned')
  }
  return activate(origin, intentId, createRes.action === 'reactivated' ? 'reactivated' : 'created', input.title, deps)
}

/**
 * Ask Kawa Code whether the user has decided, for up to [`WAIT_BUDGET_MS`].
 *
 * Only the FIRST status call of a tool call carries `countPoll`: the loop makes
 * ~20 of them per call, and the cap on polling counts tool calls.
 */
async function waitForDecision(origin: string, pendingId: string, deps: CreateIntentDeps): Promise<CreateIntentResponse> {
  const deadline = deps.now() + WAIT_BUDGET_MS
  let countPoll = true
  let pollsLeft: number | undefined

  for (;;) {
    const remaining = deadline - deps.now()
    if (remaining < MIN_STATUS_CALL_MS) break

    let res: any
    try {
      res = await deps.request(
        'intent',
        'pending-intent-status',
        { repoOrigin: origin, pendingId, countPoll },
        Math.min(remaining, MAX_STATUS_CALL_MS),
      )
    } catch (err) {
      // Kawa Code runs one request at a time, so a status call can sit behind
      // another session's slow handler (a distillation can run for minutes).
      // That is not a failure: the user has not decided, and the agent's next
      // step is the same as for any other pending reply — call again.
      if (err instanceof MuninnTimeoutError) break
      throw err
    }
    countPoll = false

    switch (res?.action) {
      case 'created':
      case 'reactivated': {
        const intentId = res.intentId || res.intent?.id || ''
        if (!intentId) throw new Error('The decision was recorded but Kawa Code returned no intent ID')
        return activate(origin, intentId, res.action, undefined, deps)
      }
      case 'declined':
        return {
          success: false,
          intentId: '',
          action: 'declined',
          message:
            'The user declined this intent. It was NOT created. Stop all work on this task now — ' +
            'make no further edits or commits — and tell the user you have stopped.',
        }
      case 'expired':
        return {
          success: false,
          intentId: '',
          action: 'expired',
          message:
            'The request went unanswered for 24 hours and expired. Nothing was created and nothing was decided. ' +
            'If the user still wants this work, call create_and_activate_intent again WITHOUT pendingId.',
        }
      case 'unknown_pending':
        return {
          success: false,
          intentId: '',
          action: 'unknown_pending',
          message:
            'Kawa Code has no pending request with that pendingId (it may have been cleaned up). ' +
            'Call create_and_activate_intent again WITHOUT pendingId to start over.',
        }
      case 'awaiting_user':
        return {
          success: false,
          intentId: '',
          action: 'awaiting_user',
          pendingId,
          pollsLeft: 0,
          message:
            'Stop checking. The decision is waiting for the user in Kawa Code (Orchestration panel). ' +
            'Tell the user, and do not call this tool again until they say they have answered; ' +
            'then call it once more with the same pendingId.',
        }
      case 'pending_approval':
        pollsLeft = typeof res.pollsLeft === 'number' ? res.pollsLeft : pollsLeft
        break
      default:
        throw new Error(`Unexpected reply from Kawa Code while waiting for the user's decision: ${JSON.stringify(res)}`)
    }

    const left = deadline - deps.now()
    if (left < MIN_STATUS_CALL_MS) break
    await deps.sleep(Math.min(POLL_INTERVAL_MS, left))
  }

  return pendingApproval(pendingId, pollsLeft)
}

function pendingApproval(pendingId: string, pollsLeft: number | undefined, conflictCount?: number): CreateIntentResponse {
  const overlap = conflictCount && conflictCount > 0
    ? `This intent overlaps with ${conflictCount} existing intent${conflictCount === 1 ? '' : 's'}. `
    : ''
  const left = pollsLeft === undefined ? '' : ` Checks left before you must stop and wait: ${pollsLeft}.`
  return {
    success: false,
    intentId: '',
    action: 'pending_approval',
    pendingId,
    pollsLeft,
    message:
      `${overlap}The user decides in Kawa Code (Orchestration panel); the intent has NOT been created. ` +
      `Tell the user it is waiting for them, then call create_and_activate_intent again with pendingId="${pendingId}" ` +
      `and the same title, description and repoPath.${left}`,
  }
}

/** Set the new intent as THIS session's current focus. Under the multi-active
 *  model (no lock) this never conflicts: it only moves this session's pointer. */
async function activate(
  origin: string,
  intentId: string,
  action: 'created' | 'reactivated',
  title: string | undefined,
  deps: CreateIntentDeps,
): Promise<CreateIntentResponse> {
  await deps.request('intent', 'set-active', { repoOrigin: origin, intentId })
  const named = title ? ` "${title}"` : ''
  const message = action === 'reactivated'
    ? `Reactivated existing similar intent${named} — resuming previous work instead of creating a duplicate.`
    : `Created and activated intent${named}`
  return { success: true, intentId, action, message }
}

export const createAndActivateIntentTool = {
  name: 'create_and_activate_intent',
  description: `Create a new intent from the user's request and mark it as active for THIS session.

Call this when check_active_intent returns no active intent for your session. Before calling:
1. Summarize what the user is asking for
2. Ask the user to confirm the intent details (title, description, type)
3. Then call this tool with the confirmed details

This ensures all AI-generated code gets properly tracked and attributed.

Multi-active model: many intents can be active on a repo at once (one per
session/teammate). Creating + activating one only sets YOUR session's current
focus — it never blocks or displaces another session's active intent.

If the new intent overlaps existing work, YOU do not decide what happens: Kawa
Code asks the user, and this tool reports the outcome. Act on "action":
- "created" / "reactivated": done; the intent is active. Proceed.
- "pending_approval": the user has been asked in Kawa Code. Tell them it is waiting
  for them, then call this tool again with the returned pendingId (same title,
  description and repoPath). Each call waits up to ~20 seconds for the answer.
- "awaiting_user": stop calling. Tell the user the decision is waiting in Kawa Code
  and call once more with the pendingId only after they say they have answered.
- "declined": the user said no. Stop all work on this task and tell them.
- "expired" / "unknown_pending": nothing was decided; call again without pendingId
  if the work is still wanted.
Never try to bypass an overlap; there is no force option.

If this tool call itself times out (before any pendingId was returned), call it
once more with the same arguments — it will not create a duplicate request.`,
  inputSchema: createAndActivateIntentSchema,
  handler: createAndActivateIntent
}
