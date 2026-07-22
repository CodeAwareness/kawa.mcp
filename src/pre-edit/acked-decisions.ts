/**
 * Pure transcript detection for the pre-edit acknowledgment gate.
 *
 * Replaces the token-keyed Muninn `pre-edit-cache`. That cache was a
 * cross-process rendezvous: the hook read it under `payload.session_id` while
 * the acknowledge wrote it under the MCP process's `CLAUDE_CODE_SESSION_ID` —
 * two id sources that diverge after a session restart (the MCP env is a frozen
 * spawn-time snapshot), so the override silently landed in a bucket the check
 * never read. See kawa.mcp decision 59ad77ed.
 *
 * The transcript sidesteps that entirely: the hook reads its OWN transcript
 * (via `payload.transcript_path`, which lives in `payload.session_id`'s
 * namespace), so no cross-process id has to agree. A `pre_edit_acknowledge`
 * tool call's presence in the transcript IS the acknowledgment record.
 *
 * Kept separate from the bin entry so it's unit-testable without triggering the
 * hook's main() — mirrors src/stop/uncompleted-commit.ts.
 */

/**
 * Every decision id the agent has acknowledged this session, read from
 * `pre_edit_acknowledge` tool_use entries in the Claude Code transcript.
 *
 * Position-independent: an acknowledgment anywhere in the session counts (the
 * override is "for the rest of THIS session"). Robust by construction — a
 * malformed line, a missing/!array `decisionIds`, or a non-array `content` is
 * skipped, never thrown. An empty set is the safe default (nothing suppressed).
 *
 * @param transcriptText raw JSONL contents of the transcript file
 */
export function ackedDecisionIds(transcriptText: string): Set<string> {
  const acked = new Set<string>()
  if (!transcriptText) return acked

  for (const line of transcriptText.split('\n')) {
    const ln = line.trim()
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
      if (item?.type !== 'tool_use') continue
      // Tolerate the MCP prefix (e.g. `mcp__kawa-intents__pre_edit_acknowledge`).
      if (!/pre_edit_acknowledge/.test(item.name || '')) continue

      const ids = item?.input?.decisionIds
      if (!Array.isArray(ids)) continue
      for (const id of ids) {
        if (typeof id === 'string' && id) acked.add(id)
      }
    }
  }

  return acked
}
