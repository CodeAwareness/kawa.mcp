import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'
import { resolveOrigin } from './resolve-origin.js'
import { forkFieldsExtensions, extractForkFields } from './_fork-fields.js'

/**
 * Merged from the former `get_intents_for_file` + `get_intents_for_lines` pair.
 * Both forwarded to the same `intent-block` domain and differed only in whether
 * a line range narrowed the query, so they cost two tool schemas in every
 * session to express one question. Passing `startLine`/`endLine` selects the
 * range-scoped `get-for-lines` action; omitting them uses `get-for-file`.
 */
export const getIntentsForFileSchema = z.object({
  repoOrigin: z.string().optional().describe('Git remote origin URL. Auto-detected from repoPath via git if not provided.'),
  repoPath: z.string().describe('Local path to the repository root'),
  filePath: z.string().describe('Path to the file (relative to repo root)'),
  startLine: z.number().min(1).optional().describe('Start line (1-based). Provide with endLine to narrow to a range.'),
  endLine: z.number().min(1).optional().describe('End line (1-based, inclusive). Provide with startLine to narrow to a range.'),
  ...forkFieldsExtensions,
})

export type GetIntentsForFileInput = z.infer<typeof getIntentsForFileSchema>

export interface FileIntentBlock {
  id: string
  startLine: number
  endLine: number
  contentSnippet: string
  intentIds: string[]
}

/** Present only when a line range was queried. */
export interface OverlappingLines {
  blockStartLine: number
  blockEndLine: number
  overlapStart: number
  overlapEnd: number
}

export interface FileIntentInfo {
  intentId: string
  title: string
  author?: string
  status: string
  description: string
  branch: string
  forkedFrom?: string
  /** Whole-file mode only. */
  blocks?: FileIntentBlock[]
  /** Range mode only. */
  overlappingLines?: OverlappingLines
}

export interface GetIntentsForFileResponse {
  filePath: string
  queryRange?: { startLine: number; endLine: number }
  intents: FileIntentInfo[]
  hasConflicts: boolean
  summary: string
  warning?: string
}

/** Fields both modes share; Muninn's two actions use differing key casings. */
function baseIntent(intent: any): Omit<FileIntentInfo, 'blocks' | 'overlappingLines'> {
  return {
    intentId: intent.intentId || intent.id || '',
    title: intent.title || 'Unknown Intent',
    author: intent.author || intent.author_name || intent.authorName,
    status: intent.status || 'active',
    description: intent.description || '',
    branch: intent.branch || '',
    forkedFrom: intent.forked_from || intent.forkedFrom,
  }
}

export async function getIntentsForFile(input: GetIntentsForFileInput): Promise<GetIntentsForFileResponse> {
  const actualOrigin = resolveOrigin(input.repoOrigin, input.repoPath)
  const ranged = input.startLine !== undefined && input.endLine !== undefined

  const res = await request(
    'intent-block',
    ranged ? 'get-for-lines' : 'get-for-file',
    {
      repoOrigin: actualOrigin,
      filePath: input.filePath,
      ...(ranged ? { startLine: input.startLine, endLine: input.endLine } : {}),
      ...extractForkFields(input),
    },
  )

  const rows: any[] = res.intents || []

  if (ranged) {
    const intents: FileIntentInfo[] = rows.map((intent: any) => ({
      ...baseIntent(intent),
      overlappingLines: {
        blockStartLine: intent.block_start_line || intent.overlappingLines?.blockStartLine || 0,
        blockEndLine: intent.block_end_line || intent.overlappingLines?.blockEndLine || 0,
        overlapStart: intent.overlap_start || intent.overlappingLines?.overlapStart || 0,
        overlapEnd: intent.overlap_end || intent.overlappingLines?.overlapEnd || 0,
      },
    }))

    const active = intents.filter(i => i.status === 'active')
    const authors = [...new Set(active.map(i => i.author).filter(Boolean))]
    const warning = active.length > 0
      ? `Lines ${input.startLine}-${input.endLine} overlap with active work by: ${authors.join(', ') || 'team members'}`
      : undefined

    return {
      filePath: input.filePath,
      queryRange: { startLine: input.startLine!, endLine: input.endLine! },
      intents,
      hasConflicts: intents.length > 0,
      summary: intents.length === 0
        ? `No intents overlap lines ${input.startLine}-${input.endLine}`
        : `${intents.length} intent(s) overlap lines ${input.startLine}-${input.endLine}`,
      warning,
    }
  }

  const intents: FileIntentInfo[] = rows.map((intent: any) => ({
    ...baseIntent(intent),
    blocks: (intent.blocks || []).map((b: any, i: number) => ({
      id: b.id || `block-${i}`,
      startLine: b.start_line || b.startLine || 0,
      endLine: b.end_line || b.endLine || 0,
      contentSnippet: b.content_snippet || b.contentSnippet || '',
      intentIds: b.intent_ids || b.intentIds || [intent.intent_id || intent.intentId || intent.id || ''],
    })),
  }))

  const hasConflicts = intents.length > 1

  return {
    filePath: input.filePath,
    intents,
    hasConflicts,
    summary: intents.length === 0
      ? 'No intents found for this file'
      : intents.length === 1
        ? `1 intent: "${intents[0].title}" (${intents[0].status})`
        : `${intents.length} intents affecting this file${hasConflicts ? ' - potential conflicts' : ''}`,
  }
}

export const getIntentsForFileTool = {
  name: 'get_intents_for_file',
  description: `Intents with code blocks in a file, so you can see in-progress work and team conflicts before editing.

Pass startLine + endLine to narrow to a range; the result then reports the exact overlap and warns when it hits a teammate's active intent.`,
  inputSchema: getIntentsForFileSchema,
  handler: getIntentsForFile,
}
