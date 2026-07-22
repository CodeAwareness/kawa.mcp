import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ackedDecisionIds } from './acked-decisions.js'

// Build one JSONL transcript line carrying an assistant message with the given
// content items — mirrors the shape scanTranscript consumes in the stop-gate.
function msgLine(content: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } })
}

function ackToolUse(name: string, decisionIds: unknown): unknown {
  return { type: 'tool_use', id: 'toolu_x', name, input: { decisionIds } }
}

test('collects decisionIds from a pre_edit_acknowledge tool_use', () => {
  const t = msgLine([ackToolUse('pre_edit_acknowledge', ['d1', 'd2'])])
  assert.deepEqual([...ackedDecisionIds(t)].sort(), ['d1', 'd2'])
})

test('tolerates the mcp__ tool-name prefix', () => {
  const t = msgLine([ackToolUse('mcp__kawa-intents__pre_edit_acknowledge', ['d9'])])
  assert.deepEqual([...ackedDecisionIds(t)], ['d9'])
})

test('unions ids across multiple acknowledge calls, deduped', () => {
  const t = [
    msgLine([ackToolUse('pre_edit_acknowledge', ['a', 'b'])]),
    msgLine([{ type: 'text', text: 'some prose' }]),
    msgLine([ackToolUse('pre_edit_acknowledge', ['b', 'c'])]),
  ].join('\n')
  assert.deepEqual([...ackedDecisionIds(t)].sort(), ['a', 'b', 'c'])
})

test('ignores other tool calls', () => {
  const t = msgLine([
    { type: 'tool_use', id: 't1', name: 'record_decision', input: { decisionIds: ['nope'] } },
    { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'x' } },
  ])
  assert.equal(ackedDecisionIds(t).size, 0)
})

test('skips malformed JSON lines without throwing', () => {
  const t = ['{ not valid json', msgLine([ackToolUse('pre_edit_acknowledge', ['ok'])]), 'also broken'].join('\n')
  assert.deepEqual([...ackedDecisionIds(t)], ['ok'])
})

test('skips a tool_use with missing or non-array decisionIds', () => {
  const t = [
    msgLine([ackToolUse('pre_edit_acknowledge', undefined)]),
    msgLine([ackToolUse('pre_edit_acknowledge', 'd1')]),
    msgLine([ackToolUse('pre_edit_acknowledge', ['real'])]),
  ].join('\n')
  assert.deepEqual([...ackedDecisionIds(t)], ['real'])
})

test('drops non-string / empty ids inside the array', () => {
  const t = msgLine([ackToolUse('pre_edit_acknowledge', ['keep', '', 42, null, { x: 1 }])])
  assert.deepEqual([...ackedDecisionIds(t)], ['keep'])
})

test('non-array message content is skipped', () => {
  const t = JSON.stringify({ message: { content: 'a string, not an array' } })
  assert.equal(ackedDecisionIds(t).size, 0)
})

test('empty / whitespace transcript yields an empty set', () => {
  assert.equal(ackedDecisionIds('').size, 0)
  assert.equal(ackedDecisionIds('\n  \n').size, 0)
})
