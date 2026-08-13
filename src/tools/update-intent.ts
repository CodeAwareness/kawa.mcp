import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'

export const updateIntentSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  intentId: z.string().optional().describe('ID of the intent to update. If omitted, updates the currently active intent.'),
  title: z.string().max(200).optional().describe('Updated title for the intent'),
  description: z.string().max(2000).optional().describe('Updated description for the intent'),
  constraints: z.array(z.string()).optional().describe('Updated constraints for this work'),
  scope: z.object({
    type: z.enum(['repo', 'folder', 'files']),
    paths: z.array(z.string())
  }).optional().describe('Updated scope for the intent'),
})

export type UpdateIntentInput = z.infer<typeof updateIntentSchema>

export interface UpdateIntentResponse {
  success: boolean
  intentId: string
  message: string
  updatedFields: string[]
  warning?: string
}

export async function updateIntent(input: UpdateIntentInput): Promise<UpdateIntentResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)


  // Resolve the intent ID: use provided intentId, or look up the active intent
  let intentId = input.intentId
  if (!intentId) {
    const activeRes = await request('intent', 'get-active', { repoOrigin: actualOrigin })
    intentId = activeRes.intentId || activeRes.intent?.id || ''
    if (!intentId) {
      return {
        success: false,
        intentId: '',
        message: 'No active intent found and no intentId provided. Create an intent first or provide an intentId.',
        updatedFields: [],
      }
    }
  }

  // Build the updates object from provided fields
  const updates: Record<string, any> = {}
  const updatedFields: string[] = []

  if (input.title !== undefined) {
    updates.title = input.title
    updatedFields.push('title')
  }
  if (input.description !== undefined) {
    updates.description = input.description
    updatedFields.push('description')
  }
  if (input.constraints !== undefined) {
    updates.constraints = input.constraints
    updatedFields.push('constraints')
  }
  if (input.scope !== undefined) {
    updates.scope = input.scope
    updatedFields.push('scope')
  }

  if (updatedFields.length === 0) {
    return {
      success: false,
      intentId,
      message: 'No fields to update. Provide at least one of: title, description, constraints, scope.',
      updatedFields: [],
    }
  }

  const res = await request('intent', 'update', {
    id: intentId,
    repoOrigin: actualOrigin,
    updates,
  })

  if (res.success === false) {
    return {
      success: false,
      intentId,
      message: res.error || 'Intent update failed',
      updatedFields: [],
    }
  }

  return {
    success: true,
    intentId,
    message: `Intent updated: ${updatedFields.join(', ')}`,
    updatedFields,
    warning: res.warning,
  }
}

export const updateIntentTool = {
  name: 'update_intent',
  description: `Update an active intent's title, description, scope, or constraints.

Use this to reformulate an intent as understanding evolves during work. Intents are
living documents — they should be updated to reflect what the work actually became,
not left as the initial guess. Common triggers for reformulation:
- The real problem turned out to be different from the initial hypothesis
- Scope expanded or narrowed during investigation
- The approach changed after discovering constraints

If no intentId is provided, the currently active intent is updated.`,
  inputSchema: updateIntentSchema,
  handler: updateIntent
}
