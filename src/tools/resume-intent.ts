import { z } from 'zod'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'
import { activateIntent } from './activate-intent.js'
import { getIntentChanges } from './get-intent-changes.js'
import { getProjectDecisions, type ProjectDecision } from './get-project-decisions.js'

/**
 * One-call intent hydration for cross-developer handoff.
 *
 * Composes three EXISTING tools/IPC actions — nothing new is added to Muninn,
 * so this works against any daemon version (backwards compatible):
 *   1. activate_intent  → adopt the intent as this session's current focus
 *   2. get_intent_changes → the (now-active) intent's title/description/status
 *   3. get_project_decisions → its recorded decisions (summary-only, lean)
 *
 * The existing tools are reused, never modified. A future Muninn
 * `decision:by-intent` filter would let step 3 avoid pulling the full project
 * list, but that's an optimization, not a requirement.
 */

export const resumeIntentSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  intentId: z.string().describe('The cloud ID (preferred) or local UUID of the intent to resume — e.g. the id from a "follow up on intent <id>" handoff.'),
  ...forkFieldsExtensions,
})

export type ResumeIntentInput = z.infer<typeof resumeIntentSchema>

export interface ResumeIntentResponse {
  resumed: boolean
  intentId: string
  intent?: { title: string; description: string; status: string }
  decisions: ProjectDecision[]
  count: number
  message: string
}

export async function resumeIntent(input: ResumeIntentInput): Promise<ResumeIntentResponse> {
  // Resolve the origin once and pass it down, so the three sub-calls don't each
  // re-shell out to git.
  const origin = resolveOrigin(input.repoOrigin, input.repoPath)
  const base = { repoOrigin: origin, repoPath: input.repoPath, ...extractForkFields(input) }

  // 1. Adopt the intent as THIS session's current focus (multi-active — never
  //    displaces another session's current). Fail loud if it can't be activated.
  const activated = await activateIntent({ ...base, intentId: input.intentId })
  if (!activated.success || !activated.intentId) {
    return {
      resumed: false,
      intentId: input.intentId,
      decisions: [],
      count: 0,
      message: `Could not resume intent ${input.intentId}: activation failed. Verify the id (cloud id or local UUID) and that the intent exists in this repo.`,
    }
  }

  // 2 + 3. Hydrate the now-active intent's metadata and its decisions in parallel.
  const [changes, project] = await Promise.all([
    getIntentChanges(base),
    getProjectDecisions(base),
  ])

  // Match decisions on every id form we know for this intent — the handoff
  // prompt may carry the cloud id while stored decisions carry a local id (or
  // vice versa), so union the passed id, the activated id, and the resolved one.
  const targetIds = new Set<string>([input.intentId, activated.intentId])
  if (changes.intent?.id) targetIds.add(changes.intent.id)
  const decisions = project.decisions.filter(
    d => targetIds.has(d.intentId) || d.intentIds.some(id => targetIds.has(id)),
  )

  const intent = changes.hasActiveIntent && changes.intent
    ? {
        title: changes.intent.title,
        description: changes.intent.description,
        status: changes.intent.status,
      }
    : undefined

  return {
    resumed: true,
    intentId: input.intentId,
    intent,
    decisions,
    count: decisions.length,
    message: intent
      ? `Resumed "${intent.title}" (${intent.status}) — ${decisions.length} recorded decision(s) loaded. Call get_decision_detail(id) for the full rationale on any of them.`
      : `Resumed intent ${input.intentId.substring(0, 8)} — ${decisions.length} recorded decision(s) loaded.`,
  }
}

export const resumeIntentTool = {
  name: 'resume_intent',
  description: `Resume an existing intent by ID in one call — activate it AND load its recorded decisions.

Use this to pick up a handoff. When a prompt says "follow up on intent <id>" (or you otherwise want to continue a specific existing intent), call resume_intent(<id>) instead of creating a new one. It:
- activates the intent as THIS session's current focus (multi-active — never displaces a teammate's active intent), and
- returns the intent's title/description/status plus its recorded decisions (summary-only; call get_decision_detail(id) for full rationale on any one).

This is the fast path for cross-developer handoff without a session or transcript export: the reasoning lives in Kawa Code, so a teammate resumes the thread from just the intent id. For the code itself, the intent's owner should have committed or pushed first (a prompt carries reasoning, not an uncommitted working tree).

Returns { resumed, intentId, intent?, decisions[], count, message }. resumed=false with a message when the id can't be activated.`,
  inputSchema: resumeIntentSchema,
  handler: resumeIntent,
}
