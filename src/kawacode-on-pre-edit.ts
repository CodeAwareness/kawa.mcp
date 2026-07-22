#!/usr/bin/env node
/**
 * kawacode-on-pre-edit — Claude Code PreToolUse hook dispatcher.
 *
 * Reads the PreToolUse hook payload from stdin (session_id, cwd, tool_name,
 * tool_input). For Edit, resolves the touched line range from old_string
 * against the file content on disk. For Write, targets the whole current
 * file (skipping new files entirely).
 *
 * Sends ONE IPC to Muninn: `pre-edit-check:evaluate` — Muninn does the
 * full evaluation (4-way data fan-out, supersedes computation, evaluator,
 * enclosing-symbol enrichment, telemetry). Replaces the ~450-LOC legacy
 * hook that did all of that locally.
 *
 * Maps recommendation to Claude Code's hook protocol:
 *   - "investigate-upstream" → exit 2 + stderr message (block)
 *     UNLESS tool_input.force === true → exit 0 (one-shot proceed)
 *   - "review"               → exit 0 + JSON on stdout (advisory)
 *   - "proceed" / silent     → exit 0, no output
 *
 * Decisions the agent has acknowledged via pre_edit_acknowledge are read from
 * this session's transcript and passed as `forceOverrides`, so Muninn filters
 * them before computing the recommendation (replaces the token-keyed
 * pre-edit-cache; kawa.mcp decision 59ad77ed).
 *
 * This hook carries only the SEMANTIC (decision-tier) signal. The live-HAI
 * code-collision signal was relocated off this per-edit path to a once-per-turn
 * check in kawacode-on-stop (COLLISION_SURFACE_RELOCATION.md) — pre-edit no
 * longer queries or surfaces collisions.
 *
 * Failure discipline: every error path exits 0. Hook must not block
 * Claude Code's turn loop on infra issues. (Same fail-soft carve-out
 * as kawacode-on-stop — see that file's header for the rule.)
 *
 * Opt out with KAWA_PRE_EDIT_CHECK=off.
 */

import { readFileSync } from 'node:fs'

import { connectToMuninn, request, disconnect, setQuiet } from './services/muninn-ipc.js'
import { resolveOrigin } from './tools/resolve-origin.js'
import { resolvePaths } from './pre-edit/path-resolve.js'
import { ackedDecisionIds } from './pre-edit/acked-decisions.js'
import { emitInjection, emitActedOn, estimateTokens } from './telemetry.js'

// Hook stderr is surfaced to the agent/user on exit-2 blocks — suppress the
// IPC lifecycle chatter so only the decision-check message comes through.
// KAWA_DEBUG=1 restores full logging for troubleshooting.
setQuiet(!process.env.KAWA_DEBUG)

interface HookPayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: {
    file_path?: string
    old_string?: string
    new_string?: string
    content?: string
    force?: boolean
    [key: string]: any
  }
}

interface ResolvedTarget {
  filePath: string // relative to repoPath
  repoPath: string
  startLine: number
  endLine: number
}

interface SurfacedDecision {
  decisionId: string
  type: string
  summary?: string
  rationale?: string
}

interface EvaluateResponse {
  triggered?: boolean
  tier?: '1a' | '1b' | null
  intents?: any[]
  decisions?: SurfacedDecision[]
  filtered?: any
  recommendation: 'proceed' | 'review' | 'investigate-upstream'
  enclosingSymbol?: { name?: string } | null
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Find the first occurrence of `needle` in `haystack` and return its 1-based
 * inclusive line range. Returns null if not found.
 */
function locateLineRange(haystack: string, needle: string): { startLine: number; endLine: number } | null {
  if (!needle) return null
  const idx = haystack.indexOf(needle)
  if (idx < 0) return null

  let startLine = 1
  for (let i = 0; i < idx; i += 1) {
    if (haystack.charCodeAt(i) === 10) startLine += 1
  }
  let extraLines = 0
  for (let i = 0; i < needle.length; i += 1) {
    if (needle.charCodeAt(i) === 10) extraLines += 1
  }
  return { startLine, endLine: startLine + extraLines }
}

function resolveTarget(payload: HookPayload): ResolvedTarget | null {
  const cwd = payload.cwd
  const toolName = payload.tool_name
  const input = payload.tool_input
  if (!cwd || !toolName || !input) return null
  const filePath = input.file_path
  if (!filePath) return null

  // Cross-platform path resolution. Returns null for files outside the repo.
  const resolved = resolvePaths(cwd, filePath)
  if (!resolved) return null
  const { absolutePath, relativePath } = resolved

  let fileContent: string
  try {
    fileContent = readFileSync(absolutePath, 'utf8')
  } catch {
    // Either Write to a new file (no prior history) or read failure — skip.
    return null
  }

  if (toolName === 'Edit') {
    const oldString = input.old_string
    if (!oldString) return null
    const range = locateLineRange(fileContent, oldString)
    if (!range) return null
    return { filePath: relativePath, repoPath: cwd, ...range }
  }

  if (toolName === 'Write') {
    const lines = fileContent.split('\n').length
    return { filePath: relativePath, repoPath: cwd, startLine: 1, endLine: Math.max(1, lines) }
  }

  return null
}

// Payload economy for the one inline-rationale surface (INTENT_INTELLIGENCE.md §5.8).
// This block is injected into the agent transcript and is append-only — it
// re-sends every turn until compaction — so per-fire size is first-class.
//   - RATIONALE_CHARS: each rationale is truncated to this, with a never-silent
//     marker that doubles as the expand pointer (amount cut + get_decision_detail).
//   - MAX_BLOCK_TOKENS: a per-fire budget; once exceeded, remaining decisions are
//     dropped with an explicit "N more suppressed" line (never a silent cap).
const RATIONALE_CHARS = 280
const MAX_BLOCK_TOKENS = 600
const CHARS_PER_TOKEN = 4 // coarse char→token approximation; deterministic, no tokenizer dep
const MAX_BLOCK_CHARS = MAX_BLOCK_TOKENS * CHARS_PER_TOKEN

function truncateRationale(d: SurfacedDecision): string {
  const r = d.rationale ?? ''
  if (r.length <= RATIONALE_CHARS) return r
  const head = r.slice(0, RATIONALE_CHARS).trimEnd()
  const cut = r.length - head.length
  return `${head}… ⟨+${cut} chars · get_decision_detail("${d.decisionId}")⟩`
}

function formatBlockMessage(target: ResolvedTarget, res: EvaluateResponse): string {
  const lines: string[] = []
  const symbol = res.enclosingSymbol?.name ? ` (in ${res.enclosingSymbol.name})` : ''
  lines.push(
    `Pre-edit decision check: prior reasoning is attached to ${target.filePath}:${target.startLine}-${target.endLine}${symbol}.`,
  )

  const decisions = res.decisions ?? []
  let usedChars = 0
  let shown = 0
  for (const d of decisions) {
    const entry: string[] = [`  • [${d.type}] ${d.summary ?? ''}`]
    const rationale = truncateRationale(d)
    if (rationale) entry.push(`    ${rationale}`)
    const entryChars = entry.join('\n').length
    // Always show at least one decision, even if it alone exceeds the budget.
    if (shown > 0 && usedChars + entryChars > MAX_BLOCK_CHARS) {
      const remaining = decisions.length - shown
      lines.push(
        `  … ${remaining} more decision${remaining === 1 ? '' : 's'} suppressed (per-fire budget) — call get_decision_detail(decisionId) to inspect.`,
      )
      break
    }
    lines.push(...entry)
    usedChars += entryChars
    shown += 1
  }

  lines.push('')
  lines.push('Override options:')
  lines.push('  1) record_decision(type:"fork", supersedes:[<id>], rationale:"...") then retry the Edit — persistent (records lineage across sessions).')
  const ackIds = decisions.map(d => `"${d.decisionId}"`).join(', ')
  lines.push(`  2) pre_edit_acknowledge({ decisionIds: [${ackIds}] }) to override for THIS session, then retry the Edit.`)
  return lines.join('\n')
}

async function main(): Promise<void> {
  if (process.env.KAWA_PRE_EDIT_CHECK === 'off') {
    process.exit(0)
  }

  const raw = readStdin()
  if (!raw) process.exit(0)

  let payload: HookPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const target = resolveTarget(payload)
  if (!target) process.exit(0)

  // Transcript-based acknowledgment (replaces the token-keyed pre-edit cache):
  // the decision ids the agent already acknowledged via pre_edit_acknowledge,
  // read from THIS session's own transcript. Same namespace as the hook
  // (payload.transcript_path is in payload.session_id's space), so no
  // cross-process session-id rendezvous — see kawa.mcp decision 59ad77ed.
  // Fail-soft: an unreadable transcript just means no overrides (surface all).
  let forceOverrides: string[] = []
  if (payload.transcript_path) {
    try {
      forceOverrides = [...ackedDecisionIds(readFileSync(payload.transcript_path, 'utf8'))]
    } catch {
      /* no transcript → behave as before (nothing suppressed) */
    }
  }

  // Resolve origin from the repo path. Falls back silently to exit 0
  // when git isn't available or the path isn't a repo.
  let repoOrigin: string
  try {
    repoOrigin = resolveOrigin(undefined, target.repoPath)
  } catch {
    process.exit(0)
  }

  try {
    await connectToMuninn()
  } catch {
    process.exit(0)
  }

  let res: EvaluateResponse
  try {
    res = await request('pre-edit-check', 'evaluate', {
      repoOrigin,
      repoPath: target.repoPath,
      filePath: target.filePath,
      startLine: target.startLine,
      endLine: target.endLine,
      forceOverrides,
    })
  } catch {
    disconnect()
    process.exit(0)
  }

  if (res?.recommendation === 'investigate-upstream') {
    const force = payload.tool_input?.force === true
    const ids = (res.decisions ?? []).map(d => d.decisionId).filter(Boolean)
    if (force) {
      // force:true is a one-shot "proceed now". The DURABLE acknowledgment is a
      // pre_edit_acknowledge call, whose presence in the transcript suppresses
      // future blocks (ackedDecisionIds above) — so there's no cache to write.
      // Track-B acted-on (VALUE_METRICS Phase 2): the agent consciously
      // overrode the surfaced reasoning — one signal per surfaced decision id.
      try {
        await Promise.allSettled(ids.map(id => emitActedOn({ type: 'pre_edit', refId: id, repoOrigin })))
      } catch { /* fire-and-forget */ }
      disconnect()
      process.exit(0)
    }
    // Block: exit 2 with stderr message. Claude Code surfaces it to the user.
    const blockMsg = formatBlockMessage(target, res)
    process.stderr.write(blockMsg + '\n')
    // Track-B injection (VALUE_METRICS Phase 2): size the injected block.
    try {
      await emitInjection({ type: 'pre_edit', tokensEst: estimateTokens(blockMsg), itemCount: ids.length, repoOrigin })
    } catch { /* fire-and-forget */ }
    disconnect()
    process.exit(2)
  }

  if (res?.recommendation === 'review') {
    const advisory = formatBlockMessage(target, res)
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: advisory,
      },
    }
    process.stdout.write(JSON.stringify(out) + '\n')
    // Track-B injection (VALUE_METRICS Phase 2): size the injected advisory.
    try {
      await emitInjection({
        type: 'pre_edit',
        tokensEst: estimateTokens(advisory),
        itemCount: (res.decisions ?? []).length,
        repoOrigin,
      })
    } catch { /* fire-and-forget */ }
    disconnect()
    process.exit(0)
  }

  // Silent — proceed.
  disconnect()
  process.exit(0)
}

main().catch(() => process.exit(0))
