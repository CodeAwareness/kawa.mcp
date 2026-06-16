import { z } from 'zod'

import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

/**
 * arbiter_resolve — thin forwarder to Muninn `arbiter:resolve` (Arbiter v2).
 * Suggest-only: judges live code overlaps with peers and returns verdicts; never
 * writes. All decrypt + judgment lives in Muninn (zero-knowledge); this is a
 * stateless adapter.
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

export const arbiterResolveSchema = z.object({
  repoPath: z.string().describe('Local path to the repository root'),
  repoOrigin: z
    .string()
    .optional()
    .describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  intentId: z
    .string()
    .optional()
    .describe('Active intent ID (advisory). Auto-detected by Kawa Code when omitted.'),
  overlaps: z
    .array(overlapSchema)
    .describe('The overlaps to judge — each { peerUid, filePath, ranges } from the Stop collision report.'),
  ...forkFieldsExtensions,
})

export type ArbiterResolveInput = z.infer<typeof arbiterResolveSchema>

export async function arbiterResolve(input: ArbiterResolveInput): Promise<any> {
  const repoOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const res = await request('arbiter', 'resolve', {
    repoOrigin,
    repoPath: input.repoPath,
    intentId: input.intentId,
    overlaps: input.overlaps,
    ...extractForkFields(input),
  })
  return res
}

export const arbiterResolveTool = {
  name: 'arbiter_resolve',
  description:
    'Get Kawa Code\'s AI verdict for live code overlaps with peers — SUGGEST-ONLY, never writes. ' +
    'For each overlap ({peerUid, filePath, ranges} from the Stop collision report), Kawa decrypts the ' +
    "peer's version locally (zero-knowledge) and judges it compatible / auto_resolvable / conflict, with " +
    'confidence, a perf/security risk read, and a tier (0 no-op · 1 trivially auto-appliable · 2 ' +
    'draft-and-confirm · 3 conflict). Use it to understand a forming conflict before acting. For a ' +
    'surfaced tier-2/3 overlap, call get_resolution_context to read the peer\'s actual code. To actually ' +
    'apply the safe tier, use arbiter_apply.',
  inputSchema: arbiterResolveSchema,
  handler: arbiterResolve,
}
