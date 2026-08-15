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

import { resolveOrigin } from './resolve-origin.js'
import { emitActedOn } from '../telemetry.js'

/**
 * Marker tool: acknowledging a pre-edit decision.
 *
 * This tool no longer writes any override state. The pre-edit hook reads THIS
 * call's presence in the session transcript (a `pre_edit_acknowledge` tool_use
 * naming `decisionIds`) and suppresses those decisions from future blocks — see
 * `src/pre-edit/acked-decisions.ts` and kawa.mcp decision 59ad77ed. That
 * transcript read lives entirely in the hook's own session namespace, so it
 * replaces the old token-keyed `pre-edit-cache`, which silently mis-routed the
 * override across the hook/MCP process boundary after a session restart.
 *
 * The only side effect here is the acted-on value-metric; the acknowledgment
 * itself is carried by the tool_use record, not by anything this handler does.
 */

export const preEditAcknowledgeSchema = z.object({
  decisionIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('Decision IDs to acknowledge (suppress from pre-edit blocks for the rest of this session)'),
  repoOrigin: z
    .string()
    .optional()
    .describe('Git remote origin URL. Auto-detected from repoPath via git if not provided. Used only to attribute the acted-on value-metric to a repo.'),
  repoPath: z
    .string()
    .optional()
    .describe('Local path to the repository root. Enables repo attribution of the acted-on value-metric.'),
})

export type PreEditAcknowledgeInput = z.infer<typeof preEditAcknowledgeSchema>

export interface PreEditAcknowledgeResponse {
  acknowledged: number
}

export async function preEditAcknowledge(
  input: PreEditAcknowledgeInput,
): Promise<PreEditAcknowledgeResponse> {
  // Track-B acted-on (VALUE_METRICS Phase 2): an explicit acknowledge IS the
  // agent acting on the surfaced pre_edit reasoning — one signal per decision
  // id. Only attributable to a repo when an origin can be resolved (this tool
  // is repo-agnostic by default); fire-and-forget, never blocks the result.
  if (input.repoOrigin || input.repoPath) {
    try {
      const origin = resolveOrigin(input.repoOrigin, input.repoPath!)
      void Promise.allSettled(input.decisionIds.map(id => emitActedOn({ type: 'pre_edit', refId: id, repoOrigin: origin })))
    } catch { /* origin unresolvable — skip attribution */ }
  }

  // No IPC: the transcript record of this call is the acknowledgment.
  return { acknowledged: input.decisionIds.length }
}

export const preEditAcknowledgeTool = {
  name: 'pre_edit_acknowledge',
  description: `Acknowledge pre-edit decisions so they stop blocking your edits for the rest of this session.

When a pre_edit_decision_check block fires and you judge the surfaced reasoning does NOT apply to your edit, call this with the surfaced decision IDs, then retry the edit — those decisions won't re-block this session. The acknowledgment is recorded by this call itself appearing in the session transcript, which the pre-edit hook reads; it needs no session token and is not affected by restarts.

For a PERSISTENT override across sessions (the reasoning is actually wrong or replaced), record a fork instead: \`record_decision(type: "fork", supersedes: [<id>])\`.

Returns:
- acknowledged: number of decision IDs acknowledged`,
  inputSchema: preEditAcknowledgeSchema,
  handler: preEditAcknowledge,
}
