import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'

export const detectIntentConflictsSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  intentId: z.string().describe('The active intent ID'),
  minScore: z.number().optional().describe('Minimum similarity score threshold (default: 0.5)'),
})

export type DetectIntentConflictsInput = z.infer<typeof detectIntentConflictsSchema>

export interface ConflictCandidate {
  intentId: string
  title: string
  description: string
  /** Opaque owner id. NOT a display name — see the note on the mapping below. */
  authorId: string
  score: number
  overlappingFiles: string[]
  decisions: {
    decisionId: string
    summary: string
    rationale: string
    type: string
    relatedFiles: string[]
  }[]
}

export interface DetectIntentConflictsResponse {
  hasConflicts: boolean
  conflicts: ConflictCandidate[]
  count: number
}

export async function detectIntentConflicts(input: DetectIntentConflictsInput): Promise<DetectIntentConflictsResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const res = await request('decision', 'detect-conflicts', {
    repoOrigin: actualOrigin,
    intentId: input.intentId,
    minScore: input.minScore,
  })

  if (res.error) {
    return {
      hasConflicts: false,
      conflicts: [],
      count: 0,
    }
  }

  const conflicts: ConflictCandidate[] = (res.conflicts || []).map((c: any) => ({
    intentId: c.intentId || '',
    title: c.title || '',
    description: c.description || '',
    // `author` (the resolved display name) is deliberately NOT forwarded.
    // DECISION_LINKING §3.3: names are resolved for the Kawa Code UX only and
    // never enter an MCP payload — a name the model cannot act on is pure
    // context cost, and it would push teammate PII into arbitrary client
    // transcripts. `authorId` stays: opaque, non-PII, and enough to tell
    // someone else's intent from your own.
    authorId: c.authorId || '',
    score: c.score || 0,
    overlappingFiles: c.overlappingFiles || [],
    decisions: (c.decisions || []).map((d: any) => ({
      decisionId: d.decisionId || '',
      summary: d.summary || '',
      rationale: d.rationale || '',
      type: d.type || '',
      relatedFiles: d.relatedFiles || [],
    })),
  }))

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    count: conflicts.length,
  }
}

export const detectIntentConflictsTool = {
  name: 'detect_intent_conflicts',
  description: `Find intents from other team members that potentially conflict with the active intent.

When to use:
- Before committing, to surface overlapping team work so the user can coordinate before merging.

Inputs of note:
- \`intentId\`: the active intent to check against.
- \`minScore\` (optional): minimum match score to include in results.

Returns scored conflict candidates with:
- \`score\`: how strongly the candidate matches (higher = more likely conflict).
- \`overlappingFiles\`: files affected by both intents.
- \`decisions\`: decisions attached to the conflicting intent.
- \`authorId\`: opaque owner id — use it only to tell whether the intent is someone else's. Who they are is shown in Kawa Code, not here.

The list is informational — review candidates and their decisions to decide whether coordination is needed.`,
  inputSchema: detectIntentConflictsSchema,
  handler: detectIntentConflicts
}
