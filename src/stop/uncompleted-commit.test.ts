import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectGateSave,
  detectUncompletedCommit,
  isGitCommitCommand,
  looksLikeCommitOutput,
  toolResultText,
} from './uncompleted-commit.js'

/** A realistic `git commit` success result (the bracketed short-hash line). */
const COMMIT_OK = '[main 1a2b3c4] Add the thing\n 1 file changed, 2 insertions(+)'

// ---- transcript line builders (Claude Code JSONL shape) ----

function bash(command: string, id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] },
  })
}

function toolUse(name: string, id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, id, input: {} }] },
  })
}

function result(toolUseId: string, opts: { isError?: boolean; text?: string } = {}): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: opts.isError ?? false, content: opts.text ?? 'ok' }],
    },
  })
}

const COMPLETE = 'mcp__kawa-intents__complete_intent'

test('isGitCommitCommand', async (t) => {
  await t.test('plain commit', () => assert.equal(isGitCommitCommand('Bash', 'git commit -m "x"'), true))
  await t.test('git -C path commit', () => assert.equal(isGitCommitCommand('Bash', 'git -C /repo commit -am "x"'), true))
  await t.test('chained with &&', () => assert.equal(isGitCommitCommand('Bash', 'git add -A && git commit -m "x"'), true))
  await t.test('dry-run excluded', () => assert.equal(isGitCommitCommand('Bash', 'git commit --dry-run'), false))
  await t.test('non-Bash tool excluded', () => assert.equal(isGitCommitCommand('Edit', 'git commit -m "x"'), false))
  await t.test('git log mentioning commit not matched', () => assert.equal(isGitCommitCommand('Bash', 'git log --pretty=%H'), false))
})

test('toolResultText flattens shapes', async (t) => {
  await t.test('string', () => assert.equal(toolResultText('hello'), 'hello'))
  await t.test('array of text parts', () => assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a b'))
  await t.test('other → empty', () => assert.equal(toolResultText({ foo: 1 }), ''))
})

test('looksLikeCommitOutput', async (t) => {
  await t.test('standard commit line', () => assert.equal(looksLikeCommitOutput('[main 1a2b3c4] msg'), true))
  await t.test('root commit', () => assert.equal(looksLikeCommitOutput('[main (root-commit) 0e1f2a3] init'), true))
  await t.test('detached HEAD', () => assert.equal(looksLikeCommitOutput('[detached HEAD abc1234] msg'), true))
  await t.test('nothing-to-commit output → false', () => assert.equal(looksLikeCommitOutput('nothing to commit, working tree clean'), false))
  await t.test('empty (printf wrote a file) → false', () => assert.equal(looksLikeCommitOutput(''), false))
  await t.test('git log oneline → false', () => assert.equal(looksLikeCommitOutput('1a2b3c4 some subject\nded5678 another'), false))
})

test('detectUncompletedCommit', async (t) => {
  await t.test('no commit at all → false', () => {
    const t1 = [toolUse('Read', 'r1'), result('r1')].join('\n')
    assert.equal(detectUncompletedCommit(t1), false)
  })

  await t.test('confirmed commit with no completion → true', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { text: COMMIT_OK })].join('\n')
    assert.equal(detectUncompletedCommit(t1), true)
  })

  await t.test('REGRESSION: command merely MENTIONS "git commit" (printf, no commit output) → false', () => {
    // The printf-in-transcript false positive: a Bash command that contains the
    // string "git commit" as data, writing a fixture; its result has no commit
    // signature, so it must NOT be read as a real commit.
    const printf = bash(`printf '%s' '{"command":"git commit -m \\"x\\""}' > /tmp/fixture.jsonl`, 'p1')
    const t1 = [printf, result('p1', { text: '' })].join('\n')
    assert.equal(detectUncompletedCommit(t1), false)
  })

  await t.test('command looks like commit but result has no signature → false', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { text: 'ok' })].join('\n')
    assert.equal(detectUncompletedCommit(t1), false)
  })

  await t.test('commit then complete_intent → false', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { text: COMMIT_OK }), toolUse(COMPLETE, 'k1'), result('k1')].join('\n')
    assert.equal(detectUncompletedCommit(t1), false)
  })

  await t.test('complete then a NEW confirmed commit after it → true', () => {
    const t1 = [
      bash('git commit -m "a"', 'c1'), result('c1', { text: COMMIT_OK }),
      toolUse(COMPLETE, 'k1'), result('k1'),
      bash('git commit -m "b"', 'c2'), result('c2', { text: '[main 9f8e7d6] b\n 1 file changed' }),
    ].join('\n')
    assert.equal(detectUncompletedCommit(t1), true)
  })

  await t.test('failed commit (is_error) → false', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { isError: true, text: 'fatal' })].join('\n')
    assert.equal(detectUncompletedCommit(t1), false)
  })

  await t.test('"nothing to commit" → false', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { text: 'On branch main\nnothing to commit, working tree clean' })].join('\n')
    assert.equal(detectUncompletedCommit(t1), false)
  })

  await t.test('attempted complete_intent (failed, conflicts) still suppresses the gate', () => {
    // complete_intent was called after the commit even though it may have failed
    // (conflicts) — the agent tried, so no nag.
    const t1 = [
      bash('git commit -m "x"', 'c1'), result('c1', { text: COMMIT_OK }),
      toolUse(COMPLETE, 'k1'), result('k1', { text: '{ "success": false, "reason": "conflicts" }' }),
    ].join('\n')
    assert.equal(detectUncompletedCommit(t1), false)
  })

  await t.test('garbage / non-JSON lines are skipped', () => {
    const t1 = ['', 'not json', bash('git commit -m "x"', 'c1'), result('c1', { text: COMMIT_OK })].join('\n')
    assert.equal(detectUncompletedCommit(t1), true)
  })
})

test('detectGateSave (VALUE_METRICS V8 acted-on)', async (t) => {
  await t.test('confirmed commit then complete_intent → true (the inverse of uncompleted)', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { text: COMMIT_OK }), toolUse(COMPLETE, 'k1'), result('k1')].join('\n')
    assert.equal(detectGateSave(t1), true)
  })

  await t.test('confirmed commit with NO completion → false (gate would still fire, not a save)', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { text: COMMIT_OK })].join('\n')
    assert.equal(detectGateSave(t1), false)
  })

  await t.test('no commit at all → false', () => {
    const t1 = [toolUse(COMPLETE, 'k1'), result('k1')].join('\n')
    assert.equal(detectGateSave(t1), false)
  })

  await t.test('command merely MENTIONS "git commit" then complete → false (no confirmed commit)', () => {
    const printf = bash(`printf '%s' 'git commit -m x' > /tmp/f`, 'p1')
    const t1 = [printf, result('p1', { text: '' }), toolUse(COMPLETE, 'k1'), result('k1')].join('\n')
    assert.equal(detectGateSave(t1), false)
  })

  await t.test('complete BEFORE the last confirmed commit → false (commit not finalized)', () => {
    const t1 = [
      toolUse(COMPLETE, 'k1'), result('k1'),
      bash('git commit -m "later"', 'c1'), result('c1', { text: COMMIT_OK }),
    ].join('\n')
    assert.equal(detectGateSave(t1), false)
  })

  await t.test('failed commit (is_error) then complete → false', () => {
    const t1 = [bash('git commit -m "x"', 'c1'), result('c1', { isError: true, text: 'fatal' }), toolUse(COMPLETE, 'k1'), result('k1')].join('\n')
    assert.equal(detectGateSave(t1), false)
  })
})
