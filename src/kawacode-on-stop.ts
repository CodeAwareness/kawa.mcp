#!/usr/bin/env node
/**
 * kawacode-on-stop — Claude Code Stop hook dispatcher.
 *
 * Fires two independent, fail-soft jobs at the end of every turn:
 *
 * 1. Thought capture (opt out: KAWA_THOUGHT_CAPTURE=off) — two IPCs to Muninn:
 *      a. capture-thoughts:capture { sessionId, transcriptPath, cwd }
 *           → Muninn reads the transcript, extracts the assistant's text
 *             content blocks (the model's visible responses), and appends them
 *             as JSONL to ~/.kawa-code/thoughts/active/session-{id}.jsonl.
 *             Thinking blocks are deliberately ignored — Claude Code redacts
 *             their plaintext on disk, so they carry no recoverable signal.
 *      b. extractor:trigger { session_id, cwd }
 *           → Muninn wakes the (debounced) extractor service which reads the
 *             fresh JSONL and emits ephemeral decisions verbalized in the
 *             assistant's responses.
 *
 * 2. Live-HAI collision report (opt out: KAWA_STOP_COLLISION_CHECK=off) — ONE
 *      IPC, stop-collision:check { repoOrigin, repoPath } (_agentId auto-stamped).
 *      Muninn recomputes the turn's working-tree diff and runs the transient
 *      /repos/collisions read once per changed file (no publish), returning the
 *      peers grouped by HAI plus the per-repo advisory|block mode. This is the
 *      once-per-turn relocation of the old per-edit Tier-2 collision check
 *      (COLLISION_SURFACE_RELOCATION.md). When peers overlap this turn's work:
 *        - advisory (default): inject the report via additionalContext (model-
 *          only context; the agent self-judges whether to coordinate/rework/
 *          surface to the user).
 *        - block (per-repo setting): emit { decision:"block", reason } so the
 *          turn stays open until the agent addresses it — but only when
 *          stop_hook_active is not already set, so we never loop the block.
 *
 * Failure discipline: every error path exits 0. Claude Code's Stop hook must
 * never block the turn loop on capture/collision failure or Muninn being down.
 * This is the ONLY place fail-soft is allowed under the no-Muninn-independence
 * rule — the hook is the boundary between the harness (which can't recover) and
 * Muninn (which re-derives missing state on the next Stop / at complete_intent).
 */

import { readFileSync } from 'node:fs'

import { connectToMuninn, request, disconnect } from './services/muninn-ipc.js'
import { resolveOrigin } from './tools/resolve-origin.js'

interface HookPayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  /** Set by Claude Code when this Stop fired because a prior Stop hook blocked.
   *  Guard against re-blocking on it to avoid an infinite block loop. */
  stop_hook_active?: boolean
}

/** A live HAI whose published diff overlaps this turn's changes, grouped by HAI
 *  across every changed file (matches Muninn's stop-collision:check shape). */
interface HaiCollision {
  uid: string
  isAgent: boolean
  label: string
  files: { fpath: string; ranges: number[][] }[]
}

interface StopCollisionResponse {
  collisions?: HaiCollision[]
  mode?: 'advisory' | 'block'
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Render one HAI's overlapping files as `path:1-3,7` (single-line ranges
 *  collapse to a single number). */
function formatFiles(files: { fpath: string; ranges: number[][] }[]): string {
  return files
    .map(f => {
      const ranges = f.ranges
        .map(r => (r[0] === r[1] ? `${r[0]}` : `${r[0]}-${r[1]}`))
        .join(',')
      return `${f.fpath}:${ranges}`
    })
    .join('; ')
}

/** Lean report (payload economy — injected into the append-only transcript):
 *  a header plus one bullet per overlapping HAI. The guidance tail is added by
 *  the caller per advisory/block mode. */
function formatCollisionReport(collisions: HaiCollision[]): string {
  const lines: string[] = [
    `Live-edit collision check: ${collisions.length} collaborator(s) have in-progress edits overlapping your changes this turn.`,
  ]
  for (const c of collisions) {
    const tag = c.isAgent ? ' (agent)' : ''
    lines.push(`  • ${c.label || c.uid}${tag} — ${formatFiles(c.files)}`)
  }
  return lines.join('\n')
}

/** Run the once-per-turn collision check. Returns the hook-protocol JSON string
 *  to print (advisory additionalContext or a block-to-continue), or null when
 *  there's nothing to surface / on any failure (fail-soft). */
async function runCollisionCheck(payload: HookPayload): Promise<string | null> {
  if (process.env.KAWA_STOP_COLLISION_CHECK === 'off') return null
  const cwd = payload.cwd
  if (!cwd) return null

  let repoOrigin: string
  try {
    repoOrigin = resolveOrigin(undefined, cwd)
  } catch {
    return null // not a git repo / git unavailable — skip
  }

  let res: StopCollisionResponse
  try {
    res = await request('stop-collision', 'check', { repoOrigin, repoPath: cwd })
  } catch {
    return null // Muninn error/timeout — fail open, no report, no block
  }

  const collisions = res?.collisions ?? []
  if (collisions.length === 0) return null

  const report = formatCollisionReport(collisions)

  // Block-to-continue only when the per-repo setting is on AND we're not already
  // inside a prior block (else the turn can never end).
  if (res?.mode === 'block' && payload.stop_hook_active !== true) {
    return JSON.stringify({
      decision: 'block',
      reason: `${report}\n\nResolve this before ending the turn: coordinate, rework, or surface it to the user.`,
    })
  }

  // Advisory (the default; also where block degrades when stop_hook_active).
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `${report}\n\nThis is advisory — decide whether to coordinate, rework, or surface it to the user before committing.`,
    },
  })
}

async function main(): Promise<void> {
  const captureOff = process.env.KAWA_THOUGHT_CAPTURE === 'off'
  const collisionOff = process.env.KAWA_STOP_COLLISION_CHECK === 'off'
  if (captureOff && collisionOff) process.exit(0)

  const raw = readStdin()
  if (!raw) process.exit(0)

  let payload: HookPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const sessionId = payload.session_id
  const transcriptPath = payload.transcript_path
  const cwd = payload.cwd

  try {
    await connectToMuninn()
  } catch {
    // Muninn down. Capture happens whenever Muninn is next up (the extractor's
    // checkpoint advances on the next successful capture); collision detection
    // simply yields no report this turn.
    process.exit(0)
  }

  // Thought capture (fire-and-forget; each IPC tolerant of the other's failure).
  const captureTasks: Promise<unknown>[] = []
  if (!captureOff && sessionId && transcriptPath) {
    captureTasks.push(
      request('capture-thoughts', 'capture', {
        sessionId,
        transcriptPath,
        cwd: cwd ?? null,
      }),
      request('extractor', 'trigger', {
        session_id: sessionId,
        cwd: cwd ?? '',
      }),
    )
  }

  // Collision check — the only producer of hook-protocol stdout.
  let collisionOutput: string | null = null
  try {
    collisionOutput = await runCollisionCheck(payload)
  } catch {
    collisionOutput = null // belt-and-suspenders fail-soft
  }

  if (captureTasks.length > 0) await Promise.allSettled(captureTasks)

  disconnect()
  if (collisionOutput) process.stdout.write(collisionOutput + '\n')
  process.exit(0)
}

main().catch(() => process.exit(0))
