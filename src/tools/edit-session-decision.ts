import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

const constraintViolationSchema = z.object({
  alternative: z.string(),
  constraint: z.string(),
  reason: z.string()
})

const decisionUpdatesSchema = z.object({
  summary: z.string().optional(),
  rationale: z.string().optional(),
  context: z.string().optional(),
  consequences: z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  relatedFiles: z.array(z.string()).optional(),
  constraintsChecked: z.array(z.string()).optional(),
  constraintViolations: z.array(constraintViolationSchema).optional(),
  /** Trigger condition / "How to apply" — pass empty string or null to clear. */
  appliesWhen: z.string().optional(),
  surface: z.array(z.enum(['pre-edit', 'intent-create', 'stop', 'recall'])).optional()
    .describe('Update the ceremony routing for this in-flight session decision. Same vocabulary as record_decision.surface.')
})

export const editSessionDecisionSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  intentId: z.string().describe('The intent ID the decision belongs to'),
  decisionId: z.string().describe('The decision ID to edit or delete'),
  action: z.enum(['update', 'delete']).describe('Action to perform: update modifies the decision, delete removes it'),
  updates: decisionUpdatesSchema.optional().describe('Partial fields to update (only for action=update)'),
  ...forkFieldsExtensions,
})

export type EditSessionDecisionInput = z.infer<typeof editSessionDecisionSchema>

export interface EditSessionDecisionResponse {
  success: boolean
  error?: string
}

export async function editSessionDecision(input: EditSessionDecisionInput): Promise<EditSessionDecisionResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const res = await request('decision', 'edit', {
    repoOrigin: actualOrigin,
    intentId: input.intentId,
    decisionId: input.decisionId,
    action: input.action,
    updates: input.updates,
    ...extractForkFields(input),
  })

  // No id receipt exists for an update/delete, so require an EXPLICIT
  // success instead of inferring it from the absence of a failure
  // (constraint cdb76224). Safe here: Kawa Code sets `success` on every
  // branch of this action, so a missing flag means an unexpected shape, not
  // a silent success. Surface `error` so the caller learns WHY — e.g. the
  // synced-decision case, which must be refined via record_decision(supersedes).
  if (res.success === true) return { success: true }

  return {
    success: false,
    error:
      typeof res.error === 'string' && res.error.length > 0
        ? res.error
        : 'The decision was NOT modified (Kawa Code did not confirm the edit). Nothing changed — re-check the decision id and intent id.',
  }
}

export const editSessionDecisionTool = {
  name: 'edit_session_decision',
  description: `Edit or delete a decision in the current session.

Use this when reviewing decisions before commit:
- action: "update" - Modify the decision fields
- action: "delete" - Remove the decision entirely

Only ephemeral (in-flight) session decisions are editable. Once a decision is
synced to Kawa Code, it is immutable — refine it instead by recording a new
decision with \`supersedes: [<id>]\`.

This allows users to curate their decision history before it's persisted.`,
  inputSchema: editSessionDecisionSchema,
  handler: editSessionDecision
}
