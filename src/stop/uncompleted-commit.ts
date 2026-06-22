/**
 * Pure transcript detection for the complete_intent hard gate (kawacode-on-stop
 * job 3). Kept separate from the bin entry so it's unit-testable without
 * triggering the hook's main().
 *
 * The signal we want: the agent ran `git commit` but never finalized the work
 * with complete_intent. We read Claude Code's own transcript (harness
 * introspection — not Muninn's concern) and compare the position of the last
 * SUCCESSFUL commit against the last complete_intent call.
 */

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

/**
 * True when the transcript shows a SUCCESSFUL `git commit` tool_use that lands
 * after the most recent complete_intent tool_use (or with no complete_intent
 * after it) — i.e. the agent committed without finalizing.
 *
 * A commit counts only when BOTH hold: the command invokes git commit AND its
 * tool_result carries the commit-success signature (not is_error). Requiring
 * the result signature is what stops a command that merely *mentions* "git
 * commit" (e.g. a printf crafting a fixture) from being read as a real commit.
 * A complete_intent call counts even if it later failed (conflicts): the agent
 * tried, so we don't nag.
 *
 * @param transcriptText raw JSONL contents of the Claude Code transcript
 */
export function detectUncompletedCommit(transcriptText: string): boolean {
  const lines = transcriptText.split('\n')
  const commits: { idx: number; id: string | undefined }[] = []
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
        if (/complete_intent/.test(name)) {
          lastCompleteIdx = i
        } else if (isGitCommitCommand(name, item?.input?.command || '')) {
          commits.push({ idx: i, id: item.id })
        }
      } else if (item?.type === 'tool_result' && item.tool_use_id) {
        results.set(item.tool_use_id, {
          isError: item.is_error === true,
          text: toolResultText(item.content),
        })
      }
    }
  }

  // Most recent commit CONFIRMED by its result signature. A candidate with no
  // result, an errored result, or output lacking the signature does not count.
  let lastCommitIdx = -1
  for (const c of commits) {
    if (!c.id) continue
    const r = results.get(c.id)
    if (!r || r.isError) continue
    if (!looksLikeCommitOutput(r.text)) continue
    if (c.idx > lastCommitIdx) lastCommitIdx = c.idx
  }

  if (lastCommitIdx === -1) return false
  return lastCommitIdx > lastCompleteIdx
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
 * Mirrors detectUncompletedCommit's parsing exactly (a commit counts only when
 * its tool_result carries the commit-success signature, per decision 64b340d8 —
 * a command merely MENTIONING "git commit" does not count) and flips the final
 * position comparison.
 *
 * Correlation, not causation: this says "a completion followed a confirmed
 * commit while the turn was held open", not "the gate caused the completion".
 */
export function detectGateSave(transcriptText: string): boolean {
  const lines = transcriptText.split('\n')
  const commits: { idx: number; id: string | undefined }[] = []
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
        if (/complete_intent/.test(name)) {
          lastCompleteIdx = i
        } else if (isGitCommitCommand(name, item?.input?.command || '')) {
          commits.push({ idx: i, id: item.id })
        }
      } else if (item?.type === 'tool_result' && item.tool_use_id) {
        results.set(item.tool_use_id, {
          isError: item.is_error === true,
          text: toolResultText(item.content),
        })
      }
    }
  }

  let lastCommitIdx = -1
  for (const c of commits) {
    if (!c.id) continue
    const r = results.get(c.id)
    if (!r || r.isError) continue
    if (!looksLikeCommitOutput(r.text)) continue
    if (c.idx > lastCommitIdx) lastCommitIdx = c.idx
  }

  if (lastCommitIdx === -1) return false
  // A complete_intent at or after the last confirmed commit = the commit is finalized.
  return lastCompleteIdx >= lastCommitIdx
}
