import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

/**
 * Thin proxy to Muninn's `pre-edit-check:evaluate` handler.
 *
 * The entire evaluator + supersedes + telemetry + 4-way data fan-out used
 * to live in this file (~280 LOC pre-thinning). Phase 2 of the kawa.mcp →
 * kawa.muninn migration moved all that logic into Muninn's
 * `services/pre_edit_check/` module. This tool's only remaining job is
 * Zod-schema validation, origin resolution, and forwarding the request.
 */

export const preEditDecisionCheckSchema = z.object({
  repoOrigin: z
    .string()
    .optional()
    .describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z
    .string()
    .describe('Local path to the repository root (also used to read the file for AST symbol detection)'),
  filePath: z
    .string()
    .describe('Path to the file being edited (relative to repoPath)'),
  startLine: z
    .number()
    .min(1)
    .describe('Start line of the touched range (1-based, inclusive)'),
  endLine: z
    .number()
    .min(1)
    .describe('End line of the touched range (1-based, inclusive)'),
  intentId: z
    .string()
    .optional()
    .describe('Active intent ID for supersedes scoping. Auto-detected by Muninn when omitted.'),
  sessionToken: z
    .string()
    .optional()
    .describe('Session scope for the force-override cache. Defaults to the MCP server\'s SESSION_ID; PreToolUse hook callers should pass Claude Code\'s session_id so writes from one process are visible to the other.'),
  ...forkFieldsExtensions,
})

export type PreEditDecisionCheckInput = z.infer<typeof preEditDecisionCheckSchema>

export interface EnclosingSymbol {
  name: string
  fullyQualifiedName: string
  kind: string
  startLine: number
  endLine: number
  signature: string
}

/** A live collaborator (HAI) whose in-progress edits overlap the touched range. */
export interface Collision {
  uid: string
  sha: string
  /** Overlapping [start,end] line ranges in the shared baseline (cSHA) space. */
  ranges: number[][]
  isAgent: boolean
  label: string
}

export interface PreEditDecisionCheckResponse {
  triggered: boolean
  tier: '1a' | '1b' | '2' | null
  intents?: any[]
  decisions?: any[]
  /** Tier 2 — live HAIs whose edits physically overlap these lines (code conflict). */
  collisions?: Collision[]
  filtered: {
    activeIntentSupersedes: string[]
    repoScopedSupersedes: string[]
    sessionForceOverrides: string[]
  }
  recommendation: 'proceed' | 'review' | 'investigate-upstream'
  enclosingSymbol: EnclosingSymbol | null
  language?: string
}

export async function preEditDecisionCheck(
  input: PreEditDecisionCheckInput,
): Promise<PreEditDecisionCheckResponse> {
  const repoOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const forkFields = extractForkFields(input)

  const res = await request('pre-edit-check', 'evaluate', {
    repoOrigin,
    repoPath: input.repoPath,
    filePath: input.filePath,
    startLine: input.startLine,
    endLine: input.endLine,
    intentId: input.intentId,
    sessionToken: input.sessionToken,
    ...forkFields,
  })

  return res as PreEditDecisionCheckResponse
}

export const preEditDecisionCheckTool = {
  name: 'pre_edit_decision_check',
  description: `Check whether the line range about to be edited has prior recorded reasoning attached.

Call this BEFORE editing code in a kawa-indexed repo. Surfaces:
- Tier 1a — overlapping intents whose blocks cover these lines (line-precise team coordination + intent-scoped decisions)
- Tier 1b — repo decisions whose relatedFiles include this file (file-coarse, catches infer_history-extracted constraints)
- Tier 2 — live collaborators (HAIs: teammates or AI agents) whose in-progress edits physically overlap these lines, returned in collisions[] (code-conflict awareness; coordinate before editing)

Decisions already overridden via record_decision(supersedes=...) are filtered out automatically.

Recommendation maps to action:
- "proceed" — nothing relevant; safe to edit
- "review" — surfaced context worth inspecting before editing
- "investigate-upstream" — prior constraint or abandoned approach matches; don't proceed without reading the rationale and either revising the change or recording a new fork decision that supersedes the old one

Also returns the smallest enclosing function/method symbol via tree-sitter (Rust/TS/JS/Python only; null for other languages) for warning readability.`,
  inputSchema: preEditDecisionCheckSchema,
  handler: preEditDecisionCheck,
}
