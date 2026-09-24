import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { requiredKeys, missingRequiredArgs, describeMissingArgs } from './_required-args.js'

/** The shape of the tool whose silent failure prompted this check. */
const RECALL_SHAPE = z.object({
  repoOrigin: z.string().optional(),
  repoPath: z.string(),
  prompt: z.string(),
  activeFiles: z.array(z.string()).optional(),
  maxIntents: z.number().optional().default(10),
  minRelevance: z.number().optional().default(0.3),
}).shape

test('required keys exclude optional and defaulted fields', () => {
  assert.deepEqual(requiredKeys(RECALL_SHAPE), ['repoPath', 'prompt'])
})

test('a defaulted field is never required, so Muninn keeps supplying the default', () => {
  assert.equal(requiredKeys(RECALL_SHAPE).includes('maxIntents'), false)
  assert.equal(requiredKeys(RECALL_SHAPE).includes('minRelevance'), false)
})

// The exact call that ran twice with no recall: `task` instead of `prompt`.
test('catches the near-miss that started this', () => {
  const missing = missingRequiredArgs(RECALL_SHAPE, {
    repoPath: '/repo',
    task: 'find context about the relate engine',
  })
  assert.deepEqual(missing, ['prompt'])
})

test('a complete call reports nothing missing', () => {
  const missing = missingRequiredArgs(RECALL_SHAPE, {
    repoPath: '/repo',
    prompt: 'find context',
  })
  assert.deepEqual(missing, [])
})

test('extra keys are not an error — only absence is checked', () => {
  const missing = missingRequiredArgs(RECALL_SHAPE, {
    repoPath: '/repo',
    prompt: 'find context',
    somethingNew: true,
  })
  assert.deepEqual(missing, [])
})

test('null counts as missing, since it reaches the handler as absent', () => {
  assert.deepEqual(missingRequiredArgs(RECALL_SHAPE, { repoPath: '/repo', prompt: null }), ['prompt'])
})

// Presence, not validity: an empty string is a malformed VALUE, and rejecting
// it here would be the full .parse() this check deliberately is not.
test('an empty string is present, not missing', () => {
  assert.deepEqual(missingRequiredArgs(RECALL_SHAPE, { repoPath: '/repo', prompt: '' }), [])
})

test('undefined args report every required key', () => {
  assert.deepEqual(missingRequiredArgs(RECALL_SHAPE, undefined), ['repoPath', 'prompt'])
})

test('the message names the tool, the parameter and what was received', () => {
  const message = describeMissingArgs('get_relevant_context', ['prompt'], {
    repoPath: '/repo',
    task: 'find context',
  })
  assert.match(message, /get_relevant_context/)
  assert.match(message, /"prompt"/)
  // Listing what arrived is what makes the near-miss obvious.
  assert.match(message, /repoPath, task/)
  assert.match(message, /Nothing was sent/)
})

test('the message pluralizes and survives an empty argument object', () => {
  const message = describeMissingArgs('some_tool', ['a', 'b'], {})
  assert.match(message, /missing required parameters "a", "b"/)
  assert.match(message, /Received: \(none\)/)
})
