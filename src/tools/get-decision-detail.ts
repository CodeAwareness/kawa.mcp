import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { DecisionRef, IntentRef, toDecisionRefs, toIntentRefs } from '../types/refs.js'

export const getDecisionDetailSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  decisionId: z.string().describe('The decision ID to expand (from a recall result, e.g. get_relevant_context)'),
})

export type GetDecisionDetailInput = z.infer<typeof getDecisionDetailSchema>

export interface DecisionDetail {
  decisionId: string
  /**
   * The intents that produced this decision, named.
   *
   * Replaces the former bare `intentId` / `intentIds[]`. Those were unanswerable
   * as shipped — "which intent produced this?" cost a round trip per id, so it
   * was never asked. Kawa Code resolves them now.
   */
  intents: IntentRef[]
  type: string
  summary: string
  rationale: string
  context?: string
  alternatives: string[]
  consequences?: string
  symptom?: string
  appliesWhen?: string | null
  surface?: string[] | null
  relatedFiles: string[]
  /**
   * The supersession chain, nearest first, each entry named and depth-stamped.
   *
   * Replaces the former bare `supersedes: string[]` — the reported symptom that
   * made "7a7d1a36 supersedes 2cc444ec" the best sentence anyone could write.
   * Empty on ~99.7% of decisions; only 28 of 8,465 carry any supersession.
   */
  supersededDecisions: DecisionRef[]
  /** Ancestors past the depth/width cap, unresolved. A floor, not a total. */
  supersededOlderCount: number
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
  })

  const d = res?.decision
  if (!d) {
    return { found: false, error: res?.error || 'Decision not found' }
  }

  return {
    found: true,
    decision: {
      decisionId: d.decisionId || d.decision_id || d._id || d.id || '',
      // Resolved by Kawa Code, which holds the API client and the label cache.
      // Fail-soft by construction: an id that did not resolve is simply absent
      // from these arrays, never an error.
      intents: toIntentRefs(res?.intents),
      supersededDecisions: toDecisionRefs(res?.supersededDecisions),
      supersededOlderCount: typeof res?.supersededOlderCount === 'number' ? res.supersededOlderCount : 0,
      type: d.decisionType || d.decision_type || d.type || '',
      summary: d.summary || '',
      rationale: d.rationale || '',
      context: d.context,
      alternatives: d.alternatives || [],
      consequences: d.consequences,
      symptom: d.symptom,
      appliesWhen: d.appliesWhen ?? d.applies_when ?? d.aw ?? null,
      surface: d.surface ?? d.sf ?? null,
      relatedFiles: d.relatedFiles || d.related_files || [],
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

Returns the decision's \`rationale\`, \`context\`, \`consequences\`, \`alternatives\`, \`symptom\`, \`appliesWhen\`, \`surface\`, and related metadata. \`found: false\` when the id is unknown in this repo.

References come pre-resolved, so describe them by name and never by ID alone:
- \`supersededDecisions\` — the supersession chain, nearest first. Each carries \`summary\` and a \`depth\` (1 = directly superseded by this decision, 2 = what *that* one superseded). Use \`depth\` to render the chain correctly: with two entries at depth 1 this decision replaced both, whereas depth 1 then 2 is a lineage. \`supersededOlderCount\` > 0 means older ancestors exist beyond the cap — say "+N older".
- \`intents\` — the intent(s) that produced this decision, with titles.`,
  inputSchema: getDecisionDetailSchema,
  handler: getDecisionDetail
}
