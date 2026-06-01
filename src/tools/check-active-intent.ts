import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

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
    /**
     * `active` — currently being worked on (default).
     * `pending` — auto-finalized by the sweeper or blocked at completion by
     * conflicts; reportable as "live context" so the agent can prompt the
     * user to resume via activate_intent or finalize via complete_intent.
     */
    status: string
    /**
     * Set when status === 'pending'. One of `sweeper-auto-finalize` (24h
     * inactivity, no conflicts) or `sweeper-blocked-conflicts` (24h
     * inactivity, distilled decisions contradicted standards).
     */
    pendingReason?: string
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
  if (!intent) {
    return { hasActiveIntent: false, activeIntents }
  }

  return {
    hasActiveIntent: true,
    activeIntents,
    intent: {
      id: intent.id || res.intentId || '',
      title: intent.title || '',
      description: intent.description || '',
      templateType: (intent.templateType || 'feature') as 'feature' | 'refactor' | 'exploration',
      constraints: intent.constraints || [],
      status: intent.status || 'active',
      pendingReason: intent.pendingReason,
      branch: intent.branch || '',
      forkedFrom: intent.forkedFrom,
      blocks: [] // Blocks are tracked separately by intent-block service
    }
  }
}

export const checkActiveIntentTool = {
  name: 'check_active_intent',
  description: `REQUIRED: Call this tool BEFORE writing any code.

Returns THIS session's current intent (\`intent\` / \`hasActiveIntent\`) if one is
set. If not, ask the user to confirm intent details and then call
create_and_activate_intent.

Multi-active model: the active intent is PER SESSION. Many intents can be active
on a repo at once — your current is independent of other sessions'/teammates'.
The response also includes \`activeIntents\`: the repo's full active set (every
session's current intent, with id/title/status/createdBy/author) for awareness
and orchestration. \`hasActiveIntent\` reflects only YOUR session; \`activeIntents\`
may be non-empty even when you have no current.

An active intent tracks what the user is working on, enabling:
- Better code context for AI-generated changes
- Conflict detection with team members
- Automatic assignment of code blocks to the intent

Status semantics:
- "active" — normal, in-progress.
- "pending" — auto-finalized by the orphan-recovery sweeper or blocked at
  completion by conflicts. Pending is treated as live context for the repo:
  prompt the user to resume the work (activate_intent) or finalize it
  (complete_intent) before starting new unrelated work. Inspect "pendingReason"
  to tell the user WHY the intent went pending — "sweeper-auto-finalize"
  (24h idle) or "sweeper-blocked-conflicts" (decisions contradicted standards
  on the auto-finalize attempt).`,
  inputSchema: checkActiveIntentSchema,
  handler: checkActiveIntent
}
