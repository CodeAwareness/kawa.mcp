/**
 * ⚠️ UNREGISTERED 2026-08-14 — retained deliberately, NOT dead code.
 *
 * This tool is no longer in `allTools` or the `src/index.ts` dispatcher, so it
 * is not exposed to any client. The `PreToolUse` hook that drove it is retired:
 * Kawa Code no longer installs it and the README no longer documents wiring it
 * up (see `INTENT_INTELLIGENCE.md` §13 for the measurements behind that call).
 *
 * The source stays so re-registering is a two-line change rather than a
 * rewrite, and so the retirement stays legible. Do not delete it, and do not
 * "clean up" the unused export. The same applies to `pre_edit_check/` in
 * kawa.muninn and to `kawacode-on-pre-edit.ts` here — the hook binary still
 * ships, so users who wired it up before the retirement keep working.
 */
import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'

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

export interface PreEditDecisionCheckResponse {
  triggered: boolean
  tier: '1a' | '1b' | null
  intents?: any[]
  decisions?: any[]
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

  const res = await request('pre-edit-check', 'evaluate', {
    repoOrigin,
    repoPath: input.repoPath,
    filePath: input.filePath,
    startLine: input.startLine,
    endLine: input.endLine,
    intentId: input.intentId,
    sessionToken: input.sessionToken,
  })

  return res as PreEditDecisionCheckResponse
}

export const preEditDecisionCheckTool = {
  name: 'pre_edit_decision_check',
  description: `Check whether the line range about to be edited has prior recorded reasoning attached.

Call this BEFORE editing code in a kawa-indexed repo. Surfaces:
- Tier 1a — overlapping intents whose blocks cover these lines (line-precise team coordination + intent-scoped decisions)
- Tier 1b — repo decisions whose relatedFiles include this file (file-coarse, catches infer_history-extracted constraints)

(Live-collaborator code-collision awareness is no longer reported here — it now arrives once per turn at the Stop hook. This tool is purely the semantic, decision-based check.)

Decisions already overridden via record_decision(supersedes=...) are filtered out automatically.

Recommendation maps to action:
- "proceed" — nothing relevant; safe to edit
- "review" — surfaced context worth inspecting before editing
- "investigate-upstream" — prior constraint or abandoned approach matches; don't proceed without reading the rationale and either revising the change or recording a new fork decision that supersedes the old one

Also returns the smallest enclosing function/method symbol via tree-sitter (Rust/TS/JS/Python only; null for other languages) for warning readability.`,
  inputSchema: preEditDecisionCheckSchema,
  handler: preEditDecisionCheck,
}
