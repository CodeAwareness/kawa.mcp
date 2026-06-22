import { z } from 'zod'

import { request, SESSION_ID } from '../services/muninn-ipc.js'
import { forkFieldsExtensions } from './_fork-fields.js'
import { resolveOrigin } from './resolve-origin.js'
import { emitActedOn } from '../telemetry.js'

/**
 * Thin proxy to Muninn's `pre-edit-cache:add` handler.
 *
 * Pre-thinning, this tool wrapped a local cache.ts module that itself
 * called the same Muninn IPC. Phase 3 of the kawa.mcp → kawa.muninn
 * migration drops the wrapper. Telemetry now lives in Muninn too —
 * the `pre-edit-cache:add` handler emits its own override event.
 */

export const preEditAcknowledgeSchema = z.object({
  decisionIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('Decision IDs to acknowledge (mark as overridden for the rest of this session)'),
  sessionToken: z
    .string()
    .optional()
    .describe('Session scope for the force-override cache. Should match the sessionToken passed to pre_edit_decision_check. Defaults to the MCP server\'s SESSION_ID.'),
  repoOrigin: z
    .string()
    .optional()
    .describe('Git remote origin URL. Auto-detected from repoPath via git if not provided. Used only to attribute the acted-on value-metric to a repo.'),
  repoPath: z
    .string()
    .optional()
    .describe('Local path to the repository root. Enables repo attribution of the acted-on value-metric.'),
  ...forkFieldsExtensions,
})

export type PreEditAcknowledgeInput = z.infer<typeof preEditAcknowledgeSchema>

export interface PreEditAcknowledgeResponse {
  acknowledged: number
  cacheSize: number
}

export async function preEditAcknowledge(
  input: PreEditAcknowledgeInput,
): Promise<PreEditAcknowledgeResponse> {
  const sessionToken = input.sessionToken ?? SESSION_ID
  const res = await request('pre-edit-cache', 'add', {
    sessionToken,
    decisionIds: input.decisionIds,
  })

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

  return {
    acknowledged: typeof res?.added === 'number' ? res.added : 0,
    cacheSize: typeof res?.total === 'number' ? res.total : 0,
  }
}

export const preEditAcknowledgeTool = {
  name: 'pre_edit_acknowledge',
  description: `Mark decisions as consciously overridden for the rest of this session.

Phase 3's PreToolUse hook calls this when the agent passes \`force: true\` on an Edit tool call to bypass a pre_edit_decision_check block. Adds the surfaced decision IDs to an in-memory session cache; subsequent pre_edit_decision_check fires filter those IDs out so the same block doesn't re-fire.

The cache resets when the MCP server process exits (= the agent session ends). For persistent override across sessions, record a fork decision via \`record_decision(type: "fork", supersedes: [<id>])\` instead.

Returns:
- acknowledged: number of newly-added IDs (existing IDs are deduped silently)
- cacheSize: total IDs currently in the session override cache`,
  inputSchema: preEditAcknowledgeSchema,
  handler: preEditAcknowledge,
}
