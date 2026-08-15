import { test } from 'node:test'
import assert from 'node:assert/strict'

import { harvestReferences, isFullId } from './referenced-ids.js'

const DECISION = 'c48374ea-15c7-4564-96a7-6a71d439ebc8'
const INTENT = '6a80150aa0c97eed460f45d6'

// ---- transcript line builders (Claude Code JSONL shape, verified against a
// real transcript: `type` at top level, role on `message`, content is an array
// of {text|tool_use|tool_result|thinking} items) ----

function userPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

function assistantThinking(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, text }] },
  })
}

function toolUse(name: string, id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, id, input: {} }] },
  })
}

/** Tool results come back as `user` messages — which is exactly why role alone
 *  cannot delimit a turn. */
function toolResult(toolUseId: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  })
}

test('collects prose from the WHOLE turn, not just the last assistant line', () => {
  // The bug this guards: one turn emits many assistant lines (one per tool
  // call), so reading only the last would miss everything written before it.
  const t = [
    userPrompt('do the thing'),
    assistantText(`Starting with ${DECISION.slice(0, 8)}`),
    toolUse('Bash', 'tu1'),
    toolResult('tu1', 'ok'),
    assistantText('Done.'),
  ].join('\n')

  const { candidates } = harvestReferences(t)
  assert.deepEqual(candidates, ['c48374ea'])
})

test('only the CURRENT turn is harvested', () => {
  const t = [
    userPrompt('first ask'),
    assistantText('mentioned aaaa1111 last turn'),
    userPrompt('second ask'),
    assistantText('mentioning bbbb2222 now'),
  ].join('\n')

  const { candidates } = harvestReferences(t)
  assert.deepEqual(candidates, ['bbbb2222'])
})

test('a tool_result does not start a new turn', () => {
  // tool_results arrive as `user` messages; if they delimited turns, everything
  // written before the last tool call would be dropped.
  const t = [
    userPrompt('do it'),
    assistantText(`see ${DECISION}`),
    toolUse('Bash', 'tu1'),
    toolResult('tu1', 'output'),
    assistantText('and done'),
  ].join('\n')

  assert.deepEqual(harvestReferences(t).candidates, [DECISION])
})

test('thinking blocks are excluded — the panel reflects what was SAID', () => {
  const t = [
    userPrompt('go'),
    assistantThinking(`privately considering ${DECISION}`),
    assistantText('publicly saying nothing'),
  ].join('\n')

  assert.deepEqual(harvestReferences(t).candidates, [])
})

test('full ids are harvested from kawa tool results only', () => {
  const t = [
    userPrompt('go'),
    toolUse('mcp__kawa-intents__get_relevant_context', 'tu1'),
    toolResult('tu1', `{"decisionId":"${DECISION}","intentId":"${INTENT}"}`),
    toolUse('Bash', 'tu2'),
    toolResult('tu2', 'commit aaaa1111-2222-4333-8444-555555555555'),
    assistantText('done'),
  ].join('\n')

  const { knownFull } = harvestReferences(t)
  assert.deepEqual(knownFull.sort(), [DECISION, INTENT].sort())
})

test('knownFull keeps only FULL ids — a prefix there disambiguates nothing', () => {
  const t = [
    userPrompt('go'),
    toolUse('mcp__kawa-intents__get_decision_detail', 'tu1'),
    toolResult('tu1', `supersedes: 1d562397 and ${DECISION}`),
    assistantText('done'),
  ].join('\n')

  assert.deepEqual(harvestReferences(t).knownFull, [DECISION])
})

test('a git short SHA is harvested as a candidate — it cannot be told apart here', () => {
  // Deliberate: the SHA and a truncated decision id are the same shape. It is
  // excluded downstream by resolution, not by pattern.
  const t = [userPrompt('go'), assistantText('committed as 2035539f')].join('\n')
  assert.deepEqual(harvestReferences(t).candidates, ['2035539f'])
})

test('tokens shorter than 8 hex characters are ignored', () => {
  const t = [userPrompt('go'), assistantText('see 2035539 and abc')].join('\n')
  assert.deepEqual(harvestReferences(t).candidates, [])
})

test('a full UUID is captured whole rather than as its leading 8 chars', () => {
  const t = [userPrompt('go'), assistantText(`"Summary" (${DECISION})`)].join('\n')
  assert.deepEqual(harvestReferences(t).candidates, [DECISION])
})

test('repeats within one turn collapse', () => {
  const t = [
    userPrompt('go'),
    assistantText('c48374ea here'),
    assistantText('and c48374ea again'),
  ].join('\n')
  assert.deepEqual(harvestReferences(t).candidates, ['c48374ea'])
})

test('case is normalized', () => {
  const t = [userPrompt('go'), assistantText('C48374EA')].join('\n')
  assert.deepEqual(harvestReferences(t).candidates, ['c48374ea'])
})

test("the session's first request is captured as a fallback label", () => {
  const t = [
    userPrompt('read DECISION_LINKING.md and tell me if W3c is ready'),
    assistantText('sure'),
    userPrompt('now do it'),
    assistantText('ok'),
  ].join('\n')

  // FIRST, not latest: the label names the session, and repos that create no
  // intents (kawa.dev-doc) will never show anything else.
  assert.equal(
    harvestReferences(t).firstRequest,
    'read DECISION_LINKING.md and tell me if W3c is ready',
  )
})

test('malformed lines and an empty transcript are survivable', () => {
  assert.deepEqual(harvestReferences('').candidates, [])
  assert.deepEqual(harvestReferences('not json\n{"broken":\n').candidates, [])
})

test('isFullId accepts UUIDs and ObjectIds, rejects prefixes', () => {
  assert.ok(isFullId(DECISION))
  assert.ok(isFullId(INTENT))
  assert.ok(!isFullId('c48374ea'))
  assert.ok(!isFullId(''))
})
