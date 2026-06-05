import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

export const getRelevantContextSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  prompt: z.string().describe('The user request to find relevant context for'),
  activeFiles: z.array(z.string()).optional().describe('Files currently being discussed or recently opened'),
  maxIntents: z.number().optional().default(10).describe('Maximum number of intents to return'),
  maxDecisions: z.number().optional().default(10).describe('Maximum number of decisions to return'),
  minRelevance: z.number().optional().default(0.3).describe('Minimum relevance score (0-1)'),
  ...forkFieldsExtensions,
})

export type GetRelevantContextInput = z.infer<typeof getRelevantContextSchema>

export interface ScoredIntent {
  id: string
  title: string
  description: string
  status: string
  templateType: string
  score: number
}

export interface ScoredDecision {
  id: string
  intentId: string
  intentIds: string[]
  type: string
  summary: string
  relatedFiles: string[]
  hasViolations: boolean
  score: number
  /** Trigger condition / "How to apply". Present only when the original decision was strong-signal enough to carry one. */
  appliesWhen?: string
}

export interface GetRelevantContextResponse {
  projectOrigin: string
  projectPath: string
  relevantIntents: ScoredIntent[]
  relevantDecisions: ScoredDecision[]
  summary: {
    totalIntentsSearched: number
    totalDecisionsSearched: number
    intentsReturned: number
    decisionsReturned: number
  }
  error?: string
}

const EMPTY_RESPONSE = (origin: string, path: string): GetRelevantContextResponse => ({
  projectOrigin: origin,
  projectPath: path,
  relevantIntents: [],
  relevantDecisions: [],
  summary: {
    totalIntentsSearched: 0,
    totalDecisionsSearched: 0,
    intentsReturned: 0,
    decisionsReturned: 0,
  },
})

export async function getRelevantContext(input: GetRelevantContextInput): Promise<GetRelevantContextResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)

  let res: any
  try {
    res = await request('search', 'context', {
      origin: actualOrigin,
      query: input.prompt,
      activeFiles: input.activeFiles || [],
      maxIntents: input.maxIntents,
      maxDecisions: input.maxDecisions,
      minScore: input.minRelevance,
      ...extractForkFields(input),
    })
  } catch (err: any) {
    const msg = err?.message || String(err)
    return { ...EMPTY_RESPONSE(actualOrigin, input.repoPath), error: `Muninn unavailable: ${msg}` }
  }

  return {
    projectOrigin: actualOrigin,
    projectPath: input.repoPath,

    relevantIntents: (res.intents || []).map((i: any) => ({
      id: i._id || i.id || '',
      title: i.title || '',
      description: i.description || '',
      status: i.status || 'active',
      templateType: i.templateType || i.template_type || 'feature',
      score: i.score || 0,
    })),

    relevantDecisions: (res.decisions || []).map((d: any) => ({
      id: d.decisionId || d.decision_id || '',
      intentId: d.intentId || d.intent_id || d.intentIds?.[0] || d.intent_ids?.[0] || '',
      intentIds: d.intentIds || d.intent_ids || (d.intentId || d.intent_id ? [d.intentId || d.intent_id] : []),
      type: d.decisionType || d.decision_type || d.type || '',
      summary: d.summary || '',
      // Lean payload (INTENT_INTELLIGENCE.md §5.8): rationale is dropped from the
      // recall surface — it dominated context accumulation (re-sent every turn).
      // Fetch full rationale on demand via get_decision_detail(decisionId).
      relatedFiles: d.relatedFiles || d.related_files || [],
      hasViolations: (d.constraintViolations || d.constraint_violations || []).length > 0,
      score: d.score || 0,
      appliesWhen: d.appliesWhen || d.applies_when || d.aw || undefined,
    })),

    summary: {
      totalIntentsSearched: res.summary?.totalIntents || 0,
      totalDecisionsSearched: res.summary?.totalDecisions || 0,
      intentsReturned: (res.intents || []).length,
      decisionsReturned: (res.decisions || []).length,
    }
  }
}

export const getRelevantContextTool = {
  name: 'get_relevant_context',
  description: `Find past intents and decisions relevant to the current user request.

When to use:
- After you have done a quick initial exploration of the user's request and know which files are involved. Calling earlier with only a vague prompt gives weak results.
- To pull task-specific context instead of dumping all recent activity — preferred for large projects.

Inputs of note:
- \`prompt\`: the user request, in their words or your paraphrase.
- \`activeFiles\` (recommended): files you have identified as relevant to the request. Significantly improves relevance.
- \`maxIntents\`, \`maxDecisions\`, \`minRelevance\`: result-shaping caps and threshold.

Returns:
- \`relevantIntents\`: past work units (intents) related to the task, scored by relevance.
- \`relevantDecisions\`: prior decisions related to the task — both intent-scoped and repo-scoped. Summary-only (no inline rationale, to keep context lean); call \`get_decision_detail(decisionId)\` for the full rationale/context/consequences of any decision you want to open.

Recommended sequence:
1. \`check_active_intent\` at session start to resume any existing work.
2. Briefly explore the user's request to identify involved files.
3. \`get_relevant_context\` with the prompt and \`activeFiles\` to inform the approach.`,
  inputSchema: getRelevantContextSchema,
  handler: getRelevantContext
}
