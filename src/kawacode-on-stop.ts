#!/usr/bin/env node
/**
 * kawacode-on-stop — Claude Code Stop hook dispatcher.
 *
 * Fires three independent, fail-soft jobs at the end of every turn:
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
 * 3. complete_intent hard gate (opt out: KAWA_COMPLETE_GATE=off) — blocks the
 *      turn when the agent ran `git commit` under an active intent but never
 *      finalized it with complete_intent, so distillation + code-block
 *      auto-capture aren't silently skipped. Detection is pure Claude Code
 *      transcript introspection (the hook's job, not Muninn's): scan for the
 *      last CONFIRMED `git commit` vs the last complete_intent tool_use. A
 *      commit is confirmed only when its command invokes git commit AND its
 *      tool_result carries git's `[<ref> <shorthash>]` success line — so a
 *      command that merely mentions "git commit" as data (printf/heredoc) is
 *      not misread as a commit. Gate only when a commit lands AFTER the most
 *      recent complete_intent call (or with none after it) — a failed/attempted
 *      complete_intent still counts as "tried", so conflict-resolution turns
 *      are not nagged. The gate attributes the commit to ITS OWN repo (parsed
 *      from `git -C`/`cd` in the command, falling back to cwd), confirms via
 *      intent:get-active that THIS session has an open current intent THERE,
 *      skips entirely when a prior nag for this commit already sits in the
 *      transcript (once per commit — never loop), and skips when the repo HEAD
 *      is already claimed by a completed intent (intent:claimed-by-commit).
 *      Output mirrors job 2: { decision:"block", reason } guarded by
 *      !stop_hook_active; once a block has fired it degrades to
 *      additionalContext. Takes precedence over the collision report on the
 *      turn it fires (finalizing the intent matters more; collisions re-surface
 *      next turn).
 *
 * Failure discipline: every error path exits 0. Claude Code's Stop hook must
 * never block the turn loop on capture/collision failure or Muninn being down.
 * This is the ONLY place fail-soft is allowed under the no-Muninn-independence
 * rule — the hook is the boundary between the harness (which can't recover) and
 * Muninn (which re-derives missing state on the next Stop / at complete_intent).
 */

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

import { connectToMuninn, request, disconnect, setQuiet } from './services/muninn-ipc.js'
import { resolveOrigin } from './tools/resolve-origin.js'
import { lastUnfinalizedCommit, nagAlreadyInTranscript, extractCommitPath, detectGateSave } from './stop/uncompleted-commit.js'
import { emitInjection, emitActedOn, estimateTokens } from './telemetry.js'

// Same rationale as kawacode-on-pre-edit: hook stderr can surface to the
// agent/user — suppress IPC lifecycle chatter. KAWA_DEBUG=1 restores it.
setQuiet(!process.env.KAWA_DEBUG)

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

  // Track-B injection (VALUE_METRICS Phase 2): size the collision report the
  // hook is about to inject (block or advisory both inject `report`).
  // Fire-and-forget; awaited so the socket write flushes before disconnect.
  try {
    await emitInjection({ type: 'stop_collision', tokensEst: estimateTokens(report), itemCount: collisions.length, repoOrigin })
  } catch { /* fire-and-forget */ }

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

// ===== Job 3: complete_intent hard gate =====

/** Current HEAD sha for `dir`, or null if unavailable. */
function gitHeadSha(dir: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim()
  } catch {
    return null
  }
}

/**
 * The complete_intent hard gate. Returns the hook-protocol JSON to print
 * (a block, or a degraded advisory), or null when there's nothing to gate /
 * on any failure (fail-soft). Mirrors runCollisionCheck's output protocol.
 *
 * Loop-fix (2026-07-03) — three suppressions before any nag:
 *  1. Repo-correct attribution: the gate targets the repo the COMMIT ran in
 *     (parsed from `git -C` / `cd` in the command), not the payload cwd. A
 *     commit in an intent-less repo (e.g. docs-only) silences naturally via
 *     no-active-intent; a cross-repo commit gates against the right intent.
 *  2. Once per commit: a prior nag after the commit in the transcript means
 *     we already asked — block once, then silence, never loop.
 *  3. Already claimed: when the target repo's HEAD is claimed by a
 *     completed/pushed/done intent (any session), the commit IS finalized —
 *     nothing to nag.
 */
async function runCompleteGate(payload: HookPayload): Promise<string | null> {
  if (process.env.KAWA_COMPLETE_GATE === 'off') return null
  const cwd = payload.cwd
  const transcriptPath = payload.transcript_path
  if (!cwd || !transcriptPath) return null

  // Cheap, IPC-free evidence first: did the agent commit without completing?
  let transcript: string
  try {
    transcript = readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }
  const commit = lastUnfinalizedCommit(transcript)
  if (!commit) return null

  // Suppression 2: we already nagged about this commit — block once, then silence.
  if (nagAlreadyInTranscript(transcript, commit.lineIdx)) return null

  // Suppression 1: attribute the commit to ITS repo. Fall back to cwd when the
  // command doesn't state a path (the commit ran in the Bash session's cwd).
  const cmdPath = extractCommitPath(commit.cmd)
  const gateDir = cmdPath ? resolvePath(cwd, cmdPath) : cwd

  let repoOrigin: string
  try {
    repoOrigin = resolveOrigin(undefined, gateDir)
  } catch {
    return null // not a git repo / git unavailable — skip
  }

  // Confirm THIS session still has an open current intent IN THE COMMIT'S REPO
  // (supplies its id/title). Intent-less repos (docs) end here.
  let res: { intent?: { id?: string; title?: string; status?: string } }
  try {
    res = await request('intent', 'get-active', { repoOrigin })
  } catch {
    return null // Muninn error/timeout — fail open, no gate
  }
  const intent = res?.intent
  if (!intent?.id) return null // already finalized (completion clears current) or no intent in play
  if ((intent.status || 'active') !== 'active') return null

  const headSha = gitHeadSha(gateDir)

  // Suppression 3: HEAD already claimed by a completed intent (any session).
  // Failure discipline matches the rest of the gate: any error → no gate.
  if (headSha) {
    try {
      const claim: { claimed?: boolean } = await request('intent', 'claimed-by-commit', { repoOrigin, sha: headSha })
      if (claim?.claimed === true) return null
    } catch {
      return null
    }
  }

  const shaShort = headSha ? ` (${headSha.slice(0, 8)})` : ''
  const title = intent.title ? `"${intent.title}"` : 'the active intent'
  // NOTE: this string carries the NAG_MARKER ('Run complete_intent(intentId=')
  // that nagAlreadyInTranscript keys on — keep them in sync.
  const call = `complete_intent(intentId="${intent.id}", status="committed"${headSha ? `, commitSha="${headSha}"` : ''})`
  const reason =
    `You committed${shaShort} under ${title} but didn't finalize it. Run ${call} so its ` +
    `decisions distill and code blocks are captured. If this commit isn't meant to finalize the ` +
    `intent, complete it with the correct status or surface it to the user.`

  // Track-B injection (VALUE_METRICS Phase 2): size the gate reason the hook is
  // about to inject (block or degraded advisory both inject `reason`).
  try {
    await emitInjection({ type: 'stop_gate', tokensEst: estimateTokens(reason), itemCount: 1, repoOrigin })
  } catch { /* fire-and-forget */ }

  // Block-to-continue, unless we already blocked once this turn (avoid a loop).
  if (payload.stop_hook_active !== true) {
    return JSON.stringify({ decision: 'block', reason })
  }
  // Degrade to advisory so the turn can end after a single block.
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `Reminder — ${reason}`,
    },
  })
}

/**
 * Gate-SAVE acted-on signal (VALUE_METRICS V8 / R2). Emits acted_on{stop_gate}
 * when a prior Stop block held the turn open (`stop_hook_active`) AND the
 * transcript now shows a confirmed commit finalized by a complete_intent — i.e.
 * the gate preceded a completion that would otherwise have skipped distillation
 * + block auto-capture. Fire-and-forget; returns its emit promise so main() can
 * flush it before disconnect. Correlation, not causation.
 */
async function emitGateSaveSignal(payload: HookPayload): Promise<void> {
  if (process.env.KAWA_COMPLETE_GATE === 'off') return
  if (payload.stop_hook_active !== true) return // only after a block held the turn open
  const cwd = payload.cwd
  const transcriptPath = payload.transcript_path
  if (!cwd || !transcriptPath) return

  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return
  }
  if (!detectGateSave(raw)) return

  let repoOrigin: string
  try {
    repoOrigin = resolveOrigin(undefined, cwd)
  } catch {
    return
  }
  try {
    await emitActedOn({ type: 'stop_gate', repoOrigin })
  } catch { /* fire-and-forget */ }
}

async function main(): Promise<void> {
  const captureOff = process.env.KAWA_THOUGHT_CAPTURE === 'off'
  const collisionOff = process.env.KAWA_STOP_COLLISION_CHECK === 'off'
  const gateOff = process.env.KAWA_COMPLETE_GATE === 'off'
  if (captureOff && collisionOff && gateOff) process.exit(0)

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

  // Fire-and-forget side tasks awaited before disconnect so their socket writes
  // flush. Includes thought capture (below) and the Track-B gate-save acted-on
  // signal (VALUE_METRICS Phase 2).
  const captureTasks: Promise<unknown>[] = []
  captureTasks.push(emitGateSaveSignal(payload))
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

  // Hook-protocol stdout producers, in precedence order. The complete_intent
  // gate wins the turn it fires (finalizing the intent matters more than a
  // collision advisory; collisions re-surface next turn). Only one JSON object
  // may be written, so fall through to the collision report only when the gate
  // produced nothing (the common case).
  let output: string | null = null
  try {
    output = await runCompleteGate(payload)
  } catch {
    output = null // belt-and-suspenders fail-soft
  }
  if (!output) {
    try {
      output = await runCollisionCheck(payload)
    } catch {
      output = null
    }
  }

  if (captureTasks.length > 0) await Promise.allSettled(captureTasks)

  disconnect()
  if (output) process.stdout.write(output + '\n')
  process.exit(0)
}

main().catch(() => process.exit(0))
