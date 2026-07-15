/**
 * Pure transcript detection for the complete_intent hard gate (kawacode-on-stop
 * job 3). Kept separate from the bin entry so it's unit-testable without
 * triggering the hook's main().
 *
 * The signal we want: the agent ran `git commit` but never finalized the work
 * with complete_intent. We read Claude Code's own transcript (harness
 * introspection — not Muninn's concern) and compare the position of the last
 * SUCCESSFUL commit against the last complete_intent call.
 *
 * The gate consumes three additional pure signals (loop-fix, 2026-07-03):
 *  - `lastUnfinalizedCommit` — the commit's command + short sha, so the gate can
 *    attribute the commit to ITS OWN repo (`extractCommitPath`) instead of cwd's.
 *  - `nagAlreadyInTranscript` — once-per-commit nag dedup, stateless: a prior
 *    gate message after the commit means we already nagged (block once, then
 *    silence — never loop).
 */

/** Marker present in every gate nag (see kawacode-on-stop.ts buildGateReason).
 *  Matching on it is backwards-compatible: historical nags contain it too. */
export const NAG_MARKER = 'Run complete_intent(intentId='

/** Flatten a tool_result `content` (string | array of {type,text}) to plain text. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'string' ? c : typeof (c as any)?.text === 'string' ? (c as any).text : ''))
      .join(' ')
  }
  return ''
}

/** A Bash command that *invokes* `git commit` (incl. `git -C <path> commit`),
 *  excluding dry runs. NOTE: a true match here is necessary but NOT sufficient —
 *  a command can merely MENTION "git commit" as data (printf/echo/heredoc/docs,
 *  `git log --grep`). Confirm an actual commit with {@link looksLikeCommitOutput}
 *  on the tool_result before treating it as a commit. */
export function isGitCommitCommand(name: string, cmd: string): boolean {
  if (name !== 'Bash' || !cmd) return false
  if (/--dry-run/.test(cmd)) return false
  return /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd)
}

/**
 * True when text contains git's commit-success line: `[<ref> <shorthash>] …`
 * (covers commit / amend / merge / cherry-pick / root-commit). This is the
 * authoritative "a commit actually happened" signal — `git log`/`git show` and
 * non-git output don't produce a bracketed short-hash line, and a command that
 * only mentions "git commit" as data produces no such output at all.
 *
 * Tradeoff: `git commit --quiet` suppresses this line, so a quiet commit is a
 * false NEGATIVE (no gate). That's the safe bias for a hard gate — a missed nag
 * is far less disruptive than a false block (the printf-in-transcript bug).
 */
export function looksLikeCommitOutput(text: string): boolean {
  return /\[[^\]\n]*\b[0-9a-f]{7,40}\b[^\]\n]*\]/.test(text)
}

/** A confirmed commit found in the transcript. */
export interface ConfirmedCommit {
  /** Transcript line index of the commit tool_use. */
  lineIdx: number
  /** The Bash command that produced the commit. */
  cmd: string
  /** Short sha extracted from git's `[<ref> <shorthash>]` success line ('' if unparseable). */
  shortSha: string
}

interface TranscriptScan {
  /** Confirmed commits (command invoked git commit AND result carries the success line). */
  commits: ConfirmedCommit[]
  /** Line index of the most recent complete_intent tool_use (-1 when none). */
  lastCompleteIdx: number
}

/** Extract the short sha from git's commit-success line, e.g. `[main 463f33c] msg`. */
function commitShaFromOutput(text: string): string {
  const m = /\[[^\]\n]*\b([0-9a-f]{7,40})\b[^\]\n]*\]/.exec(text)
  return m ? m[1] : ''
}

/**
 * Single transcript pass shared by every detector: collects CONFIRMED commits
 * (command + result signature, not is_error) and the last complete_intent
 * position. A complete_intent call counts even if it later failed (conflicts):
 * the agent tried, so we don't nag.
 */
function scanTranscript(transcriptText: string): TranscriptScan {
  const lines = transcriptText.split('\n')
  const candidates: { idx: number; id: string | undefined; cmd: string }[] = []
  const results = new Map<string, { isError: boolean; text: string }>()
  let lastCompleteIdx = -1

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (!ln) continue
    let obj: any
    try {
      obj = JSON.parse(ln)
    } catch {
      continue
    }
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue

    for (const item of content) {
      if (item?.type === 'tool_use') {
        const name: string = item.name || ''
        const cmd: string = item?.input?.command || ''
        if (/complete_intent/.test(name)) {
          lastCompleteIdx = i
        } else if (isGitCommitCommand(name, cmd)) {
          candidates.push({ idx: i, id: item.id, cmd })
        }
      } else if (item?.type === 'tool_result' && item.tool_use_id) {
        results.set(item.tool_use_id, {
          isError: item.is_error === true,
          text: toolResultText(item.content),
        })
      }
    }
  }

  // Keep only candidates CONFIRMED by their result signature. A candidate with
  // no result, an errored result, or output lacking the signature does not count.
  const commits: ConfirmedCommit[] = []
  for (const c of candidates) {
    if (!c.id) continue
    const r = results.get(c.id)
    if (!r || r.isError) continue
    if (!looksLikeCommitOutput(r.text)) continue
    commits.push({ lineIdx: c.idx, cmd: c.cmd, shortSha: commitShaFromOutput(r.text) })
  }

  return { commits, lastCompleteIdx }
}

/**
 * The most recent CONFIRMED commit that is NOT followed by a complete_intent
 * call — i.e. the commit the gate would nag about — or null when every commit
 * is finalized (or there are no commits).
 */
export function lastUnfinalizedCommit(transcriptText: string): ConfirmedCommit | null {
  const { commits, lastCompleteIdx } = scanTranscript(transcriptText)
  let last: ConfirmedCommit | null = null
  for (const c of commits) {
    if (!last || c.lineIdx > last.lineIdx) last = c
  }
  if (!last) return null
  return last.lineIdx > lastCompleteIdx ? last : null
}

/**
 * True when the transcript shows a SUCCESSFUL `git commit` tool_use that lands
 * after the most recent complete_intent tool_use (or with no complete_intent
 * after it) — i.e. the agent committed without finalizing.
 *
 * @param transcriptText raw JSONL contents of the Claude Code transcript
 */
export function detectUncompletedCommit(transcriptText: string): boolean {
  return lastUnfinalizedCommit(transcriptText) !== null
}

/**
 * Repo attribution for a commit command (loop-fix): the directory the commit
 * actually ran in, when the command states it.
 *
 *  1. `git -C <path> commit …` — the path is on the commit invocation itself
 *     (highest precedence).
 *  2. `cd <path> && … git commit …` — the LAST `cd` before the git commit
 *     segment. Handles `;` and `&&` chains.
 *
 * Returns null when the command carries no path (the commit ran in the Bash
 * session's cwd — the caller falls back to the hook payload cwd). Quoted paths
 * are unwrapped; relative paths are returned as-is (caller resolves).
 */
export function extractCommitPath(cmd: string): string | null {
  if (!cmd) return null

  const unquote = (s: string): string => {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1)
    }
    return s
  }

  // 1. git -C <path> … commit
  const dashC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)(?=\s)[^&;|]*\bcommit\b/.exec(cmd)
  if (dashC) return unquote(dashC[1])

  // 2. last `cd <path>` before the git commit segment
  const commitIdx = cmd.search(/\bgit\s+(?:-C\s+\S+\s+)?commit\b/)
  if (commitIdx === -1) return null
  const before = cmd.slice(0, commitIdx)
  let lastCd: string | null = null
  const cdRe = /(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g
  let m: RegExpExecArray | null
  while ((m = cdRe.exec(before)) !== null) {
    lastCd = unquote(m[1])
  }
  return lastCd
}

/**
 * Once-per-commit nag dedup (stateless): true when a prior gate nag already
 * appears in the transcript AFTER the commit — Claude Code records both the
 * block feedback and the degraded advisory as transcript content, so the
 * transcript itself is the memory. Raw line matching (not JSON parsing) keeps
 * this robust to how the harness encodes hook output.
 */
export function nagAlreadyInTranscript(transcriptText: string, commitLineIdx: number): boolean {
  const lines = transcriptText.split('\n')
  for (let i = commitLineIdx + 1; i < lines.length; i++) {
    if (lines[i].includes(NAG_MARKER)) return true
  }
  return false
}

/**
 * Gate-SAVE detection (VALUE_METRICS.md V8): the inverse of an uncompleted
 * commit — a CONFIRMED `git commit` exists AND a complete_intent call lands at
 * or after it (the commit was finalized). Used at the Stop hook to emit the
 * acted-on signal only when a prior gate block held the turn open
 * (`stop_hook_active`) and the agent then completed the intent — i.e. the gate
 * preceded a completion that would otherwise have skipped distillation +
 * block auto-capture.
 *
 * Correlation, not causation: this says "a completion followed a confirmed
 * commit while the turn was held open", not "the gate caused the completion".
 */
export function detectGateSave(transcriptText: string): boolean {
  const { commits, lastCompleteIdx } = scanTranscript(transcriptText)
  let lastCommitIdx = -1
  for (const c of commits) {
    if (c.lineIdx > lastCommitIdx) lastCommitIdx = c.lineIdx
  }
  if (lastCommitIdx === -1) return false
  // A complete_intent at or after the last confirmed commit = the commit is finalized.
  return lastCompleteIdx >= lastCommitIdx
}
