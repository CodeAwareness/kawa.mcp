import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'

export const updateFeaturesSchema = z.object({
  repoPath: z.string().describe('Local path to the repository root'),
})

export type UpdateFeaturesInput = z.infer<typeof updateFeaturesSchema>

export interface UpdateFeaturesResponse {
  success: boolean
  count?: number
  driftSpinoffs?: number
  forcedFallback?: number
  origin?: string
  error?: string
  message: string
}

export async function updateFeatures(input: UpdateFeaturesInput): Promise<UpdateFeaturesResponse> {
  // An extend is a single model call over the full feature catalog plus the
  // unassigned intents, so it can take tens of seconds on a large catalog —
  // use a generous timeout like the synchronous infer_history estimate path.
  const UPDATE_TIMEOUT_MS = 180_000
  const res = await request('feature', 'update', { repoPath: input.repoPath }, UPDATE_TIMEOUT_MS)

  if (res && res.success === false) {
    const error = res.error ?? 'unknown error'
    return { success: false, error, message: `Feature update failed: ${error}` }
  }

  const count = res?.count ?? 0
  const driftSpinoffs = res?.driftSpinoffs ?? 0
  const forcedFallback = res?.forcedFallback ?? 0

  const notes: string[] = []
  if (driftSpinoffs) notes.push(`${driftSpinoffs} drift spin-off${driftSpinoffs === 1 ? '' : 's'}`)
  if (forcedFallback) notes.push(`${forcedFallback} unsorted`)
  const suffix = notes.length ? ` (${notes.join(', ')})` : ''

  return {
    success: true,
    count,
    driftSpinoffs,
    forcedFallback,
    origin: res?.origin,
    message: `Feature catalog updated: ${count} feature${count === 1 ? '' : 's'}${suffix}.`,
  }
}

export const updateFeaturesTool = {
  name: 'update_features',
  description: `Update the project's feature catalog from its recorded intents.

Additively groups any intents that are not yet assigned to a feature into the running catalog (an incremental "extend"), without disturbing existing features. The feature catalog is the high-level "what does this project actually do?" view, derived from the repo's intents.

When to use:
- After recording or completing intents, to keep the feature list current.
- On demand, when you want the catalog refreshed with recent work.

Behavior:
- Additive only — never deletes or re-derives existing features.
- Intents already assigned to a feature are skipped; only unassigned ones are processed.
- Runs in the Kawa Code desktop app and returns the resulting feature count.`,
  inputSchema: updateFeaturesSchema,
  handler: updateFeatures,
}
