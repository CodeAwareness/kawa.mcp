import { request, isConnected, RepoAccessError, repoAccessToolOutput } from '../services/muninn-ipc.js'

export interface ActiveIntentResource {
  uri: string
  name: string
  description: string
  mimeType: string
}

export const activeIntentResource: ActiveIntentResource = {
  uri: 'kawa://intent/active',
  name: 'Active Intent',
  description: 'The currently active intent for the connected repository',
  mimeType: 'application/json'
}

export async function readActiveIntentResource(repoOrigin?: string): Promise<string> {
  if (!isConnected()) {
    return JSON.stringify({
      hasActiveIntent: false,
      note: 'Muninn is not running. Start Muninn to use intent tracking.'
    }, null, 2)
  }

  try {
    const res = await request('intent', 'get-active', {
      repoOrigin: repoOrigin || '',
    })

    // Muninn returns { hasActiveIntent, intentId, intent }
    const intent = res.intent
    if (!intent) {
      return JSON.stringify({
        hasActiveIntent: false,
        repoOrigin: repoOrigin || undefined,
        note: repoOrigin
          ? undefined
          : 'No active intent. Call check_active_intent with a repoOrigin.'
      }, null, 2)
    }

    return JSON.stringify({
      hasActiveIntent: true,
      repoOrigin: intent.repoOrigin || repoOrigin,
      intent: {
        id: intent.id || '',
        title: intent.title || '',
        description: intent.description || '',
        templateType: intent.templateType || 'feature',
        status: intent.status || 'active',
        constraints: intent.constraints || [],
        blockCount: 0
      }
    }, null, 2)
  } catch (err) {
    // A refusal is not a failed query: relay the structured, non-retryable output.
    if (err instanceof RepoAccessError) {
      return JSON.stringify(repoAccessToolOutput(err, activeIntentResource.uri), null, 2)
    }
    return JSON.stringify({
      hasActiveIntent: false,
      note: 'Failed to query Muninn for active intent.'
    }, null, 2)
  }
}

export const resources = [activeIntentResource]
