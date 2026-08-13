import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'

export const listTeamIntentsSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  status: z.enum(['active', 'committed', 'pushed', 'done', 'abandoned']).optional()
    .describe('Filter by intent status.'),
  author: z.string().optional().describe('Filter by author name or ID'),
  since: z.string().optional().describe('Filter intents updated after this ISO8601 date (e.g. "2026-04-01")'),
  until: z.string().optional().describe('Filter intents updated before this ISO8601 date'),
  limit: z.number().optional().default(50).describe('Maximum number of intents to return (default: 50)'),
  offset: z.number().optional().default(0).describe('Number of intents to skip for pagination (default: 0)'),
})

export type ListTeamIntentsInput = z.infer<typeof listTeamIntentsSchema>

export interface TeamIntent {
  id: string
  title: string
  description: string
  author: string
  status: string
  templateType: string
  branch: string
  forkedFrom?: string
  fileCount: number
  updatedAt: string
}

export interface ListTeamIntentsResponse {
  intents: TeamIntent[]
  count: number
  summary: string
}

export async function listTeamIntents(input: ListTeamIntentsInput): Promise<ListTeamIntentsResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)

  const offset = input.offset ?? 0
  const limit = input.limit ?? 50

  // Server-side pagination + filtering via intent:list-paginated. The older
  // intent:list handler hard-capped the API call at limit=50/offset=0, so
  // pagination and filters could never see past the first 50 intents.
  const res = await request('intent', 'list-paginated', {
    repoOrigin: actualOrigin,
    lang: 'en',
    limit,
    offset,
    status: input.status,
    author: input.author,
    since: input.since,
    until: input.until,
  })

  const intents: TeamIntent[] = (res.intents || []).map((intent: any) => ({
    id: intent.id || '',
    title: intent.title || '',
    description: intent.description || '',
    author: intent.author || intent.author_name || intent.authorName || 'Unknown',
    status: intent.status || 'active',
    templateType: intent.template_type || intent.templateType || 'feature',
    branch: intent.branch || '',
    forkedFrom: intent.forked_from || intent.forkedFrom,
    fileCount: intent.file_count || intent.fileCount || 0,
    updatedAt: intent.updated_at || intent.updatedAt || ''
  }))

  // totalCount is the full filtered result size on the server; intents is the page.
  const total = typeof res.totalCount === 'number' ? res.totalCount : intents.length
  const activeCount = intents.filter(i => i.status === 'active').length
  const summary = total === 0
    ? 'No intents found'
    : `${intents.length} intent(s) returned (${total} total${offset > 0 ? `, offset ${offset}` : ''}), ${activeCount} active`

  return {
    intents,
    count: total,
    summary
  }
}

export const listTeamIntentsTool = {
  name: 'list_team_intents',
  description: `List intents from team members for this repository.

Use this to:
- See what your team is working on
- Check for potential overlapping work before starting a new task
- Review the status of various features/refactors in progress

Filtering (status, author, date range) and pagination are applied server-side across the full result set (default: 50 per page; use limit/offset to page). \`count\` is the total number of matching intents, not just the returned page.`,
  inputSchema: listTeamIntentsSchema,
  handler: listTeamIntents
}
