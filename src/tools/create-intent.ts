import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'

export const createAndActivateIntentSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  title: z.string().max(200).describe('Short, descriptive title for the intent'),
  description: z.string().max(2000).describe('What this intent accomplishes'),
  templateType: z.enum(['feature', 'refactor', 'exploration']).default('feature').describe('Type of work'),
  constraints: z.array(z.string()).optional().describe('Requirements or constraints for this work'),
  force: z.boolean().optional().default(false).describe('Bypass conflict detection. Set to true after the user has reviewed detected conflicts and chosen to proceed anyway.'),
})

export type CreateIntentInput = z.infer<typeof createAndActivateIntentSchema>

interface ConflictInfo {
  intentId: string
  title: string
  author: string
  status: string
  createdBy: string
  staleness: 'fresh' | 'aging' | 'likely_stale'
  severity: 'high' | 'medium' | 'low'
  overlapType: string
  overlappingFiles: string[]
  similarityScore: number
  oppositionDetected: boolean
  oppositionDetail: string | null
}

export interface CreateIntentResponse {
  success: boolean
  intentId: string
  action: 'created' | 'reactivated' | 'conflict'
  message: string
  conflicts?: ConflictInfo[]
}

export async function createAndActivateIntent(input: CreateIntentInput): Promise<CreateIntentResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)

  // Step 1: Create the intent. If a sufficiently similar one created by THIS
  // session already exists, the server may reactivate it instead of creating a
  // duplicate (dedup is scoped per-session — IMPLEMENTATION_PLAN_MULTI_ACTIVE_INTENTS.md
  // §10.4 — so two sessions' near-duplicates are surfaced as conflicts, not merged).
  const createRes = await request('intent', 'create', {
    repoOrigin: actualOrigin,
    title: input.title,
    description: input.description,
    templateType: input.templateType,
    constraints: input.constraints || [],
    scope: { type: 'repo', paths: [] },
    force: input.force || false,
  })

  // Handle conflict detection — API returned 409 with conflict data.
  // Return the conflicts to the caller (Claude Code) so it can present
  // them to the user and optionally retry with force=true.
  if (createRes.conflict === true && createRes.conflicts) {
    const conflicts: ConflictInfo[] = createRes.conflicts

    const lines: string[] = [
      `Found ${conflicts.length} potential conflict(s) with existing intents:`,
      '',
    ]
    for (const c of conflicts) {
      const badge = c.severity === 'high' ? '[HIGH]' : c.severity === 'medium' ? '[MEDIUM]' : '[LOW]'
      lines.push(`${badge} "${c.title}" by ${c.author} (${c.status}, ${c.staleness})`)
      if (c.overlappingFiles.length > 0) {
        lines.push(`  Files: ${c.overlappingFiles.join(', ')}`)
      }
      if (c.oppositionDetected) {
        lines.push(`  Semantic opposition: ${c.oppositionDetail}`)
      }
      lines.push(`  Similarity: ${(c.similarityScore * 100).toFixed(0)}%`)
      lines.push('')
    }
    lines.push('To proceed anyway, call create_and_activate_intent again with force=true.')

    return {
      success: false,
      intentId: '',
      action: 'conflict',
      message: lines.join('\n'),
      conflicts,
    }
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
  const action: 'created' | 'reactivated' = createRes.action === 'reactivated' ? 'reactivated' : 'created'

  // Step 2: Set it as THIS session's current intent. Under the multi-active
  // model (no lock) set-active never conflicts — many intents can be active per
  // repo at once, and this only moves this session's `current` focus pointer.
  await request('intent', 'set-active', {
    repoOrigin: actualOrigin,
    intentId,
  })

  const message = action === 'reactivated'
    ? `Reactivated existing similar intent: "${input.title}" — resuming previous work instead of creating a duplicate.`
    : `Created and activated intent: "${input.title}"`

  return {
    success: true,
    intentId,
    action,
    message,
  }
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
focus — it never blocks or displaces another session's active intent, so there
is no lock conflict to resolve.

If the tool returns conflicts (action="conflict"), it found an existing
team-member intent that overlaps semantically or in files. Present the conflict
details to the user and ask whether to proceed. If yes, retry with force=true to
bypass conflict detection.`,
  inputSchema: createAndActivateIntentSchema,
  handler: createAndActivateIntent
}
