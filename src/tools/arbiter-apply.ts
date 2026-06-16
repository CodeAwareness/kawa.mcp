import { z } from 'zod'

import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

/**
 * arbiter_apply — thin forwarder to Muninn `arbiter:apply` (Arbiter v2).
 * Judges → adversarially verifies → auto-applies only the trivial tier, and ONLY
 * in an agent-owned worktree. All judgment/verify/write/republish lives in Muninn;
 * this is a stateless adapter.
 */
const overlapSchema = z.object({
  peerUid: z
    .string()
    .describe('The peer HAI whose live edits overlap — a collision `uid` from the Stop report.'),
  filePath: z.string().describe('File with the overlap, relative to repoPath.'),
  ranges: z
    .array(z.array(z.number()))
    .describe('Overlapping [start, end] line ranges (cSHA line space) from the collision.'),
})

export const arbiterApplySchema = z.object({
  repoPath: z.string().describe('Local path to the repository root'),
  repoOrigin: z
    .string()
    .optional()
    .describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  intentId: z
    .string()
    .optional()
    .describe('Active intent ID (advisory; the auto-resolution decision is recorded under it).'),
  overlaps: z
    .array(overlapSchema)
    .describe('The overlaps to resolve — each { peerUid, filePath, ranges } from the Stop collision report.'),
  ...forkFieldsExtensions,
})

export type ArbiterApplyInput = z.infer<typeof arbiterApplySchema>

export async function arbiterApply(input: ArbiterApplyInput): Promise<any> {
  const repoOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const res = await request('arbiter', 'apply', {
    repoOrigin,
    repoPath: input.repoPath,
    intentId: input.intentId,
    overlaps: input.overlaps,
    ...extractForkFields(input),
  })
  return res
}

export const arbiterApplyTool = {
  name: 'arbiter_apply',
  description:
    'Resolve live code overlaps and AUTO-APPLY the safe tier. Kawa judges → adversarially verifies → and, ' +
    'for the trivial tier only (high-confidence single-range merge that passes verify), writes the merge to ' +
    'your worktree, records a decision, and republishes. Writes happen ONLY in an agent-owned worktree (a ' +
    'linked git worktree); on a human checkout — or when a peer holds the file-set lock — it behaves like ' +
    'arbiter_resolve (suggest-only, no writes). Returns per-overlap outcomes { tier, applied, announcement, ' +
    'verifyIssue?, verdict }. Call it when you are ready to incorporate the result, then RE-READ any file it ' +
    'applied to (it changed on disk). For surfaced (not-applied) overlaps, use get_resolution_context to see ' +
    'the peer code and resolve manually.',
  inputSchema: arbiterApplySchema,
  handler: arbiterApply,
}
