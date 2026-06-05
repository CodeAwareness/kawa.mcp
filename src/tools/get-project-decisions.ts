import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

export const getProjectDecisionsSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  ...forkFieldsExtensions,
})

export type GetProjectDecisionsInput = z.infer<typeof getProjectDecisionsSchema>

export interface ConstraintViolation {
  alternative: string
  constraint: string
  reason: string
}

export interface ProjectDecision {
  intentId: string
  intentIds: string[]
  id: string
  timestamp: string
  type: 'fork' | 'abandoned' | 'discovery' | 'constraint' | 'tradeoff' | 'dependency'
  summary: string
  relatedFiles: string[]
  constraintsChecked: string[]
  constraintViolations: ConstraintViolation[]
}

export interface GetProjectDecisionsResponse {
  decisions: ProjectDecision[]
  count: number
}

export async function getProjectDecisions(input: GetProjectDecisionsInput): Promise<GetProjectDecisionsResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const res = await request('decision', 'project-list', {
    repoOrigin: actualOrigin,
    ...extractForkFields(input),
  })

  const decisions: ProjectDecision[] = (res.decisions || []).map((d: any) => ({
    intentId: d.intent_id || d.intentId || d.intent_ids?.[0] || d.intentIds?.[0] || '',
    intentIds: d.intent_ids || d.intentIds || (d.intent_id || d.intentId ? [d.intent_id || d.intentId] : []),
    id: d.decision_id || d.decisionId || d._id || d.id || '',
    timestamp: d.timestamp || d.created_at || d.createdAt || '',
    type: d.decision_type || d.decisionType || d.type,
    summary: d.summary || '',
    // Lean payload (INTENT_INTELLIGENCE.md §5.8): the unbounded free-text fields
    // (rationale/context/consequences/alternatives) are dropped from this recall
    // surface. Fetch them on demand via get_decision_detail(decisionId).
    relatedFiles: d.related_files || d.relatedFiles || [],
    constraintsChecked: d.constraints_checked || d.constraintsChecked || [],
    constraintViolations: d.constraint_violations || d.constraintViolations || []
  }))

  return {
    decisions,
    count: decisions.length
  }
}

export const getProjectDecisionsTool = {
  name: 'get_project_decisions',
  description: `Get all decisions recorded for a project across all intents.

Use this to review the project's decision history:
- See what architectural decisions have been made
- Understand past trade-offs and their rationale
- Find decisions affecting specific files
- Review constraint violations that were avoided

Returns:
- decisions: Array of decisions with their intent context
- count: Total number of decisions

Each decision includes (summary-only, to keep context lean — call get_decision_detail(decisionId) for full rationale/context/consequences/alternatives):
- intentIds: The intents this decision belongs to (array — a decision can span multiple intents)
- type: fork, abandoned, discovery, constraint, tradeoff, or dependency
- summary: Brief description of the decision
- relatedFiles: Files affected by this decision
- constraintViolations: Options that were rejected due to constraints`,
  inputSchema: getProjectDecisionsSchema,
  handler: getProjectDecisions
}
