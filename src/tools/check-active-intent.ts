import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'
import { emitInjection, estimateTokens } from '../telemetry.js'

export const checkActiveIntentSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  ...forkFieldsExtensions,
})

export type CheckActiveIntentInput = z.infer<typeof checkActiveIntentSchema>

export interface IntentBlock {
  id: string
  filePath: string
  startLine: number
  endLine: number
  contentSnippet: string
}

/**
 * One entry in the repo's active set. Under the multi-active model many intents
 * can be `status:active` at once (one focus per session/teammate); this is a
 * lightweight summary for the orchestration view, distinct from the calling
 * session's own `current` intent (the top-level `intent`).
 */
export interface ActiveIntentSummary {
  id: string
  title: string
  status: string
  createdBy?: string
  author?: string
}

export interface ActiveIntentResponse {
  hasActiveIntent: boolean
  /**
   * The repo's full active set — every session/teammate's currently-active
   * intent — for orchestration/awareness. Independent of `hasActiveIntent`,
   * which reports only whether THIS session has a current focus.
   */
  activeIntents?: ActiveIntentSummary[]
  intent?: {
    id: string
    title: string
    description: string
    templateType: 'feature' | 'refactor' | 'exploration'
    constraints: string[]
    /** `active` — currently being worked on (default). Terminal states:
     * committed/pushed/done/abandoned/superseded. */
    status: string
    branch: string
    forkedFrom?: string
    blocks: IntentBlock[]
  }
}

export async function checkActiveIntent(input: CheckActiveIntentInput): Promise<ActiveIntentResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)

  const res = await request('intent', 'get-active', {
    repoOrigin: actualOrigin,
    ...extractForkFields(input),
  })

  // Muninn returns { hasActiveIntent, intentId, intent, activeIntents }.
  // The active set is present regardless of whether THIS session has a current.
  const activeIntents: ActiveIntentSummary[] = Array.isArray(res.activeIntents)
    ? res.activeIntents.map((it: any) => ({
        id: it.id || it._id || '',
        title: it.title || '',
        status: it.status || 'active',
        createdBy: it.createdBy || undefined,
        author: it.authorInfo?.name || it.author || undefined,
      }))
    : []

  const intent = res.intent
  let response: ActiveIntentResponse
  if (!intent) {
    response = { hasActiveIntent: false, activeIntents }
  } else {
    response = {
      hasActiveIntent: true,
      activeIntents,
      intent: {
        id: intent.id || res.intentId || '',
        title: intent.title || '',
        description: intent.description || '',
        templateType: (intent.templateType || 'feature') as 'feature' | 'refactor' | 'exploration',
        constraints: intent.constraints || [],
        status: intent.status || 'active',
        branch: intent.branch || '',
        forkedFrom: intent.forkedFrom,
        blocks: [] // Blocks are tracked separately by intent-block service
      }
    }
  }

  // Track-B injection telemetry (VALUE_METRICS Phase 2): size the serialized
  // result (≈ chars/4); itemCount = active-set size + 1 if this session has a
  // current intent. Fire-and-forget — never blocks the tool result.
  void emitInjection({
    type: 'check_active',
    tokensEst: estimateTokens(JSON.stringify(response)),
    itemCount: activeIntents.length + (intent ? 1 : 0),
    repoOrigin: actualOrigin,
  })

  return response
}

export const checkActiveIntentTool = {
  name: 'check_active_intent',
  description: `REQUIRED before writing any code. Returns this session's current intent; if there is none, confirm the details with the user and call create_and_activate_intent.

Intents are active PER SESSION — many can be active on one repo at once. hasActiveIntent reflects only YOUR session, while activeIntents lists every session's current intent (yours and teammates') and may be non-empty when you have none. A stale intent stays "active"; terminal states are committed / pushed / done / abandoned / superseded.`,
  inputSchema: checkActiveIntentSchema,
  handler: checkActiveIntent
}
