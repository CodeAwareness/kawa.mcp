import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { IntentRef, toIntentRef } from '../types/refs.js'

export const getSessionDecisionsSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  intentId: z.string().describe('The intent ID to get decisions for'),
})

export type GetSessionDecisionsInput = z.infer<typeof getSessionDecisionsSchema>

export interface ConstraintViolation {
  alternative: string
  constraint: string
  reason: string
}

export interface DecisionPoint {
  id: string
  timestamp: string
  type: 'fork' | 'abandoned' | 'discovery' | 'constraint' | 'tradeoff' | 'dependency'
  summary: string
  relatedFiles: string[]
  constraintsChecked: string[]
  constraintViolations: ConstraintViolation[]
  appliesWhen?: string
}

export interface GetSessionDecisionsResponse {
  intentId: string
  /**
   * The intent these decisions belong to, named.
   *
   * Every decision here shares one parent — the caller named it — so this is a
   * single ref, not one per row. Resolved cache-only by Kawa Code, so it is
   * absent on a cold cache rather than costing a round trip to label an intent
   * the caller already identified.
   */
  intent?: IntentRef
  decisions: DecisionPoint[]
  count: number
}

export async function getSessionDecisions(input: GetSessionDecisionsInput): Promise<GetSessionDecisionsResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const res = await request('decision', 'list', {
    repoOrigin: actualOrigin,
    intentId: input.intentId,
  })

  const decisions: DecisionPoint[] = (res.decisions || []).map((d: any) => ({
    id: d.decision_id || d.decisionId || d._id || d.id || '',
    timestamp: d.timestamp || d.created_at || d.createdAt || '',
    type: d.decision_type || d.decisionType || d.type,
    summary: d.summary || '',
    // Lean payload (INTENT_INTELLIGENCE.md §5.8): unbounded free-text fields
    // (rationale/context/consequences/alternatives/symptom) are dropped from this
    // recall surface. Fetch them on demand via get_decision_detail(decisionId).
    // appliesWhen is retained — it is short, high-signal, and excluded from embeddings.
    relatedFiles: d.related_files || d.relatedFiles || [],
    constraintsChecked: d.constraints_checked || d.constraintsChecked || [],
    constraintViolations: d.constraint_violations || d.constraintViolations || [],
    appliesWhen: d.applies_when || d.appliesWhen || d.aw || undefined
  }))

  return {
    intentId: input.intentId,
    intent: toIntentRef(res?.intent) ?? undefined,
    decisions,
    count: decisions.length
  }
}

export const getSessionDecisionsTool = {
  name: 'get_session_decisions',
  description: `Get all decisions recorded in the current session for an intent.

Use this before committing to review what decisions were captured during development.
Decisions are presented for user review and can be edited or removed before being persisted.

Returns:
- intentId: The intent these decisions belong to
- decisions: Array of decision points (summary-only — call get_decision_detail(decisionId) for full rationale/context/consequences/alternatives)
- count: Number of decisions recorded`,
  inputSchema: getSessionDecisionsSchema,
  handler: getSessionDecisions
}
