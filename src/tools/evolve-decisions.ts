import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

export const evolveDecisionsSchema = z.object({
  stories: z.array(z.any()).describe('Array of story objects from a previous infer_history run'),
  repoPath: z.string().optional().describe('Local path to the repository root (required for auto-persist after evolution)'),
  repoOrigin: z.string().optional().describe('Git remote origin URL (auto-detected from repoPath if not provided)'),
  ...forkFieldsExtensions,
})

export type EvolveDecisionsInput = z.infer<typeof evolveDecisionsSchema>

export interface EvolveDecisionsResponse {
  started: boolean
  message: string
}

export async function evolveDecisions(input: EvolveDecisionsInput): Promise<EvolveDecisionsResponse> {
  const res = await request('inference', 'evolve', {
    stories: input.stories,
    repoPath: input.repoPath,
    repoOrigin: input.repoOrigin,
    ...extractForkFields(input),
  })

  return {
    started: res.started,
    message: res.message || 'Evolution pipeline started. Progress updates will be sent as the pipeline runs.'
  }
}

export const evolveDecisionsTool = {
  name: 'evolve_decisions',
  description: `Curate a set of previously extracted stories so that only the decisions still worth keeping are persisted.

When to use:
- After running \`infer_history\` in story-only mode (rare — \`infer_history\` already chains this step automatically).
- When you have a pre-existing set of stories you want to re-curate without re-running history extraction.

Inputs:
- \`stories\`: array of story objects from a previous \`infer_history\` run.
- \`repoPath\` (optional): when provided, curated results are persisted as intents and decisions for the repo after curation finishes.

Behavior:
- Runs asynchronously — returns immediately with a started/pending status while progress is reported separately. Progress and the final persisted counts are reported in the Kawa Code app, not returned to this call.
- The model used for curation is configured in the Kawa Code app and is not selectable per call.`,
  inputSchema: evolveDecisionsSchema,
  handler: evolveDecisions
}
