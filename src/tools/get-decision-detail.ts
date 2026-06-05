import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

export const getDecisionDetailSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  decisionId: z.string().describe('The decision ID to expand (from a recall result, e.g. get_relevant_context)'),
  ...forkFieldsExtensions,
})

export type GetDecisionDetailInput = z.infer<typeof getDecisionDetailSchema>

export interface DecisionDetail {
  decisionId: string
  intentId: string
  intentIds: string[]
  type: string
  summary: string
  rationale: string
  context?: string
  alternatives: string[]
  consequences?: string
  symptom?: string
  appliesWhen?: string | null
  relatedFiles: string[]
  supersedes: string[]
  constraintsChecked: string[]
  constraintViolations: any[]
  timestamp?: string
}

export interface GetDecisionDetailResponse {
  found: boolean
  decision?: DecisionDetail
  error?: string
}

export async function getDecisionDetail(input: GetDecisionDetailInput): Promise<GetDecisionDetailResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const res = await request('decision', 'detail', {
    repoOrigin: actualOrigin,
    decisionId: input.decisionId,
    ...extractForkFields(input),
  })

  const d = res?.decision
  if (!d) {
    return { found: false, error: res?.error || 'Decision not found' }
  }

  return {
    found: true,
    decision: {
      decisionId: d.decisionId || d.decision_id || d._id || d.id || '',
      intentId: d.intentId || d.intent_id || d.intentIds?.[0] || d.intent_ids?.[0] || '',
      intentIds: d.intentIds || d.intent_ids || (d.intentId || d.intent_id ? [d.intentId || d.intent_id] : []),
      type: d.decisionType || d.decision_type || d.type || '',
      summary: d.summary || '',
      rationale: d.rationale || '',
      context: d.context,
      alternatives: d.alternatives || [],
      consequences: d.consequences,
      symptom: d.symptom,
      appliesWhen: d.appliesWhen ?? d.applies_when ?? d.aw ?? null,
      relatedFiles: d.relatedFiles || d.related_files || [],
      supersedes: d.supersedes || [],
      constraintsChecked: d.constraintsChecked || d.constraints_checked || [],
      constraintViolations: d.constraintViolations || d.constraint_violations || [],
      timestamp: d.timestamp || d.createdAt || d.created_at,
    },
  }
}

export const getDecisionDetailTool = {
  name: 'get_decision_detail',
  description: `Expand one decision to its full detail.

Recall surfaces (get_relevant_context, get_project_decisions, get_session_decisions) return decisions summary-only to keep context lean. Use this to pull the full reasoning for a single decision you want to open — pay for detail only where you ask for it.

Inputs:
- \`decisionId\`: the decision to expand (the \`id\` / \`decisionId\` from a recall result).

Returns the decision's \`rationale\`, \`context\`, \`consequences\`, \`alternatives\`, \`symptom\`, \`appliesWhen\`, and related metadata. \`found: false\` when the id is unknown in this repo.`,
  inputSchema: getDecisionDetailSchema,
  handler: getDecisionDetail
}
