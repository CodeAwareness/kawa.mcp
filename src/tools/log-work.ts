import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'

export const logWorkSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to repository root'),
  title: z.string().max(200).describe('Short description of the work done'),
  files: z.array(z.string()).optional().describe('File paths modified (relative to repo root)'),
})

export type LogWorkInput = z.infer<typeof logWorkSchema>

export interface LogWorkResponse {
  success: boolean
  intentId: string
  message: string
}

export async function logWork(input: LogWorkInput): Promise<LogWorkResponse> {
  const origin = resolveOrigin(input.repoOrigin, input.repoPath)

  const res = await request('intent', 'log-work', {
    repoOrigin: origin,
    title: input.title,
    files: input.files || [],
  })

  // Positive receipt required: a logged work item always comes back with an id.
  // `res.success !== false` alone would report success for any response that
  // merely omits `success` (see constraint cdb76224), and the message below
  // asserted success unconditionally.
  const intentId = typeof res.intentId === 'string' ? res.intentId : ''
  if (res.success === false || !intentId) {
    return {
      success: false,
      intentId: '',
      message: res.error || 'Nothing was logged (Kawa Code returned no intent id). Re-send, and report the failure rather than assuming it was captured.',
    }
  }

  return {
    success: true,
    intentId,
    message: `Logged: "${input.title}"`
  }
}

export const logWorkTool = {
  name: 'log_work',
  description: 'DEPRECATED — trivial changes (typos, one-line fixes, obvious bugs, doc updates, config changes) should skip the intent workflow entirely: just make the change and commit, no intent needed. Do not call this tool. Kept available for backwards compatibility only and will be removed in a future release.',
  inputSchema: logWorkSchema,
  handler: logWork
}
