import { test } from 'node:test'
import assert from 'node:assert/strict'
import { salvageMangledArgs } from './_salvage-mangled-args.js'

const FIELDS = ['summary', 'rationale', 'consequences', 'symptom', 'appliesWhen', 'alternatives', 'relatedFiles']

test('recovers a string field absorbed by a mis-closed host parameter', () => {
  const { args, salvaged } = salvageMangledArgs(
    {
      consequences: 'Real consequences text.</consequences>\n<parameter name="symptom">Real symptom text.',
    },
    FIELDS,
  )

  assert.equal(args.consequences, 'Real consequences text.')
  assert.equal(args.symptom, 'Real symptom text.')
  assert.deepEqual(salvaged, [{ field: 'symptom', fromField: 'consequences' }])
})

test('JSON-parses an absorbed array value', () => {
  const { args } = salvageMangledArgs(
    {
      consequences: 'Text.</consequences>\n<parameter name="alternatives">["option A", "option B"]',
    },
    FIELDS,
  )

  assert.equal(args.consequences, 'Text.')
  assert.deepEqual(args.alternatives, ['option A', 'option B'])
})

test('unwinds a chain of consecutive mangled parameters', () => {
  const { args, salvaged } = salvageMangledArgs(
    {
      consequences:
        'C text.</consequences>\n<parameter name="symptom">S text.</symptom>\n<parameter name="appliesWhen">A text.',
    },
    FIELDS,
  )

  assert.equal(args.consequences, 'C text.')
  assert.equal(args.symptom, 'S text.')
  assert.equal(args.appliesWhen, 'A text.')
  assert.equal(salvaged.length, 2)
})

test('does NOT salvage when the closing tag does not name the host field', () => {
  // Genuine prose that merely mentions the markers — e.g. a decision recorded
  // *about* this bug. Left untouched.
  const original = 'Docs: a value may end with </consequences>\n<parameter name="symptom">like so.'
  const { args, salvaged } = salvageMangledArgs({ rationale: original }, FIELDS)

  assert.equal(args.rationale, original)
  assert.equal(args.symptom, undefined)
  assert.deepEqual(salvaged, [])
})

test('does NOT salvage an unknown target field', () => {
  const original = 'Text.</consequences>\n<parameter name="notARealField">value'
  const { args, salvaged } = salvageMangledArgs({ consequences: original }, FIELDS)

  assert.equal(args.consequences, original)
  assert.deepEqual(salvaged, [])
})

test('never overwrites a target the caller actually supplied', () => {
  const original = 'Text.</consequences>\n<parameter name="symptom">absorbed symptom'
  const { args, salvaged } = salvageMangledArgs(
    { consequences: original, symptom: 'genuine symptom' },
    FIELDS,
  )

  assert.equal(args.symptom, 'genuine symptom')
  assert.equal(args.consequences, original)
  assert.deepEqual(salvaged, [])
})

test('leaves clean args untouched and reports no salvage', () => {
  const input = { summary: 'A summary', alternatives: ['x'], relatedFiles: ['a.ts'] }
  const { args, salvaged } = salvageMangledArgs(input, FIELDS)

  assert.deepEqual(args, input)
  assert.deepEqual(salvaged, [])
})

test('does not mutate the caller-supplied args object', () => {
  const input: Record<string, unknown> = {
    consequences: 'Text.</consequences>\n<parameter name="symptom">S.',
  }
  salvageMangledArgs(input, FIELDS)

  assert.equal(input.consequences, 'Text.</consequences>\n<parameter name="symptom">S.')
})

test('keeps the raw text when an absorbed structured value is not valid JSON', () => {
  const { args } = salvageMangledArgs(
    { consequences: 'Text.</consequences>\n<parameter name="alternatives">[not, valid, json' },
    FIELDS,
  )

  assert.equal(args.alternatives, '[not, valid, json')
})

test('ignores non-string fields', () => {
  const { args, salvaged } = salvageMangledArgs(
    { relatedFiles: ['a.ts', 'b.ts'], summary: 'clean' },
    FIELDS,
  )

  assert.deepEqual(args.relatedFiles, ['a.ts', 'b.ts'])
  assert.deepEqual(salvaged, [])
})
