import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMangledArgs, describeChainedArgs } from './_mangled-args.js'

const FIELDS = [
  'summary',
  'rationale',
  'consequences',
  'symptom',
  'appliesWhen',
  'alternatives',
  'relatedFiles',
  'supersedes',
]

test('recovers a single string field absorbed by a mis-closed host parameter', () => {
  const { args, salvaged, chained } = resolveMangledArgs(
    {
      consequences: 'Real consequences text.</consequences>\n<parameter name="symptom">Real symptom text.',
    },
    FIELDS,
  )

  assert.equal(args.consequences, 'Real consequences text.')
  assert.equal(args.symptom, 'Real symptom text.')
  assert.deepEqual(salvaged, [{ field: 'symptom', fromField: 'consequences' }])
  assert.deepEqual(chained, [])
})

test('JSON-parses an absorbed array value', () => {
  const { args } = resolveMangledArgs(
    {
      consequences: 'Text.</consequences>\n<parameter name="alternatives">["option A", "option B"]',
    },
    FIELDS,
  )

  assert.equal(args.consequences, 'Text.')
  assert.deepEqual(args.alternatives, ['option A', 'option B'])
})

test('refuses a chain instead of unwinding it', () => {
  // Prod shape (decision 048c8de5): the inner parameter closed correctly, so the
  // array and the next field ran together. Separating them is reconstruction.
  const original =
    'R text.</rationale>\n<parameter name="supersedes">["146172a8"]</parameter>\n<parameter name="alternatives">["keep DELETE on abandon"]'
  const { args, salvaged, chained } = resolveMangledArgs({ rationale: original }, FIELDS)

  assert.equal(args.rationale, original, 'left untouched — the caller refuses the call')
  assert.equal(args.supersedes, undefined)
  assert.deepEqual(salvaged, [])
  assert.deepEqual(chained, [{ field: 'rationale', absorbed: 'supersedes' }])
})

test('refuses when the recovered value keeps a trailing close tag', () => {
  // Prod shape (decision e484aadb): the last field kept its own close plus the
  // emission's block closers.
  const { salvaged, chained } = resolveMangledArgs(
    {
      consequences:
        'C text.</consequences>\n<parameter name="relatedFiles">["deploy.sh"]</parameter>\n</invoke>',
    },
    FIELDS,
  )

  assert.deepEqual(salvaged, [])
  assert.equal(chained.length, 1)
})

test('refuses when the emission was cut off mid-tag', () => {
  // Prod shape (decision 077c1809).
  const { salvaged, chained } = resolveMangledArgs(
    { rationale: 'R text.</rationale>\n<parameter name="symptom">S text.</symptom>\n<paramet' },
    FIELDS,
  )

  assert.deepEqual(salvaged, [])
  assert.equal(chained.length, 1)
})

test('does NOT touch prose that merely mentions the markers', () => {
  // A decision (or intent description) recorded *about* this bug. Two such
  // records exist in prod and must keep passing through untouched.
  const original = 'Docs: a value may end with </consequences>\n<parameter name="symptom">like so.'
  const { args, salvaged, chained } = resolveMangledArgs({ rationale: original }, FIELDS)

  assert.equal(args.rationale, original)
  assert.equal(args.symptom, undefined)
  assert.deepEqual(salvaged, [])
  assert.deepEqual(chained, [])
})

test('does NOT act on an unknown target field', () => {
  const original = 'Text.</consequences>\n<parameter name="notARealField">value'
  const { args, salvaged, chained } = resolveMangledArgs({ consequences: original }, FIELDS)

  assert.equal(args.consequences, original)
  assert.deepEqual(salvaged, [])
  assert.deepEqual(chained, [])
})

test('never overwrites a target the caller actually supplied', () => {
  const original = 'Text.</consequences>\n<parameter name="symptom">absorbed symptom'
  const { args, salvaged } = resolveMangledArgs(
    { consequences: original, symptom: 'genuine symptom' },
    FIELDS,
  )

  assert.equal(args.symptom, 'genuine symptom')
  assert.equal(args.consequences, original)
  assert.deepEqual(salvaged, [])
})

test('leaves clean args untouched and reports nothing', () => {
  const input = { summary: 'A summary', alternatives: ['x'], relatedFiles: ['a.ts'] }
  const { args, salvaged, chained } = resolveMangledArgs(input, FIELDS)

  assert.deepEqual(args, input)
  assert.deepEqual(salvaged, [])
  assert.deepEqual(chained, [])
})

test('does not mutate the caller-supplied args object', () => {
  const input: Record<string, unknown> = {
    consequences: 'Text.</consequences>\n<parameter name="symptom">S.',
  }
  resolveMangledArgs(input, FIELDS)

  assert.equal(input.consequences, 'Text.</consequences>\n<parameter name="symptom">S.')
})

test('keeps the raw text when an absorbed structured value is not valid JSON', () => {
  const { args } = resolveMangledArgs(
    { consequences: 'Text.</consequences>\n<parameter name="alternatives">[not, valid, json' },
    FIELDS,
  )

  assert.equal(args.alternatives, '[not, valid, json')
})

test('ignores non-string fields', () => {
  const { args, salvaged } = resolveMangledArgs(
    { relatedFiles: ['a.ts', 'b.ts'], summary: 'clean' },
    FIELDS,
  )

  assert.deepEqual(args.relatedFiles, ['a.ts', 'b.ts'])
  assert.deepEqual(salvaged, [])
})

test('the chained refusal names the host and the first absorbed field', () => {
  const message = describeChainedArgs('record_decision', [
    { field: 'rationale', absorbed: 'supersedes' },
  ])

  assert.match(message, /record_decision/)
  assert.match(message, /"rationale" absorbed "supersedes"/)
  assert.match(message, /nothing was recorded/)
})
