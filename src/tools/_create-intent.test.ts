import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MuninnTimeoutError } from '../services/muninn-ipc.js'
import {
  createIntentFlow,
  createAndActivateIntentSchema,
  WAIT_BUDGET_MS,
  MAX_STATUS_CALL_MS,
  type CreateIntentDeps,
  type CreateIntentInput,
} from './create-intent.js'

const INPUT: CreateIntentInput = {
  repoPath: '/repo',
  title: 'Add X',
  description: 'because',
  templateType: 'feature',
}

interface Call { domain: string; action: string; data: any; timeoutMs?: number; at: number }

/** A fake Muninn and a fake clock. `sleep` advances the clock; a reply may also
 *  cost time (a busy Kawa Code), which is how the deadline gets tested. */
function harness(replies: Array<any | ((call: Call) => any)>, opts: { costMs?: number } = {}) {
  let t = 1_000_000
  const calls: Call[] = []
  let i = 0
  const deps: CreateIntentDeps = {
    now: () => t,
    sleep: async ms => { t += ms },
    resolveOrigin: () => 'github.com:acme/widgets',
    request: async (domain, action, data, timeoutMs) => {
      const call: Call = { domain, action, data, timeoutMs, at: t }
      calls.push(call)
      t += opts.costMs ?? 0
      const reply = replies[Math.min(i++, replies.length - 1)]
      const out = typeof reply === 'function' ? reply(call) : reply
      if (out instanceof Error) throw out
      return out
    },
  }
  return { deps, calls, elapsed: () => t - 1_000_000 }
}

const pending = (pollsLeft = 4) => ({ success: true, action: 'pending_approval', pendingId: 'p-1', pollsLeft })

// --- force is gone -----------------------------------------------------------

test('force is not part of the schema', () => {
  assert.equal('force' in createAndActivateIntentSchema.shape, false)
  assert.equal('pendingId' in createAndActivateIntentSchema.shape, true)
})

test('a call that passes force:true is refused before anything is sent', async () => {
  const h = harness([{}])
  await assert.rejects(
    createIntentFlow({ ...INPUT, force: true } as CreateIntentInput, h.deps),
    /`force` is no longer accepted/,
  )
  assert.equal(h.calls.length, 0)
})

test('force:false carries no meaning and is not an error', async () => {
  const h = harness([{ success: true, action: 'created', intent: { id: 'i-1' } }, {}])
  const r = await createIntentFlow({ ...INPUT, force: false } as CreateIntentInput, h.deps)
  assert.equal(r.action, 'created')
})

// --- the first call ----------------------------------------------------------

test('no overlap: created, then set active under this session', async () => {
  const h = harness([{ success: true, action: 'created', intent: { id: 'i-1' } }, { success: true }])
  const r = await createIntentFlow(INPUT, h.deps)
  assert.deepEqual([r.success, r.action, r.intentId], [true, 'created', 'i-1'])
  assert.deepEqual(h.calls.map(c => `${c.domain}:${c.action}`), ['intent:create', 'intent:set-active'])
  assert.equal(h.calls[0].data.force, undefined, 'force is never sent')
  assert.equal(h.calls[1].data.intentId, 'i-1')
})

test('an existing similar intent of this session is reactivated', async () => {
  const h = harness([{ success: true, action: 'reactivated', intent: { id: 'i-9' } }, {}])
  const r = await createIntentFlow(INPUT, h.deps)
  assert.equal(r.action, 'reactivated')
  assert.match(r.message, /Reactivated/)
})

test('an overlap returns pending_approval at once, without waiting or polling', async () => {
  const h = harness([{ success: true, action: 'pending_approval', pendingId: 'p-1', conflictCount: 2 }])
  const r = await createIntentFlow(INPUT, h.deps)
  assert.deepEqual([r.success, r.action, r.pendingId, r.intentId], [false, 'pending_approval', 'p-1', ''])
  assert.match(r.message, /overlaps with 2 existing intents/)
  assert.match(r.message, /pendingId="p-1"/)
  assert.equal(h.calls.length, 1, 'no status call yet')
  assert.equal(h.elapsed(), 0, 'and no waiting')
})

test('the pending_approval reply carries no conflict titles, authors or ids', async () => {
  // Even if Kawa Code (wrongly) sent the details along, none reach the model.
  const h = harness([{
    success: true, action: 'pending_approval', pendingId: 'p-1', conflictCount: 1,
    conflicts: [{ title: 'SECRET TITLE', author: 'A Display Name', intentId: '6a1de54431fc5095c5645ce5' }],
  }])
  const text = JSON.stringify(await createIntentFlow(INPUT, h.deps))
  for (const leaked of ['SECRET TITLE', 'A Display Name', '6a1de544', 'author']) {
    assert.equal(text.includes(leaked), false, `leaked ${leaked}`)
  }
})

test('an error from Kawa Code is raised so the agent can tell the user how to recover', async () => {
  const h = harness([{ success: false, error: "You're not signed in to Kawa Code." }])
  await assert.rejects(createIntentFlow(INPUT, h.deps), /not signed in/)
})

test('a create that times out is raised, not mistaken for a pending request', async () => {
  const h = harness([new MuninnTimeoutError(30_000, 'intent', 'create')])
  await assert.rejects(createIntentFlow(INPUT, h.deps), MuninnTimeoutError)
})

// --- waiting with a pendingId -----------------------------------------------

const WITH_ID: CreateIntentInput = { ...INPUT, pendingId: 'p-1' }

test('the first status call of a tool call counts as a poll; the rest of that call do not', async () => {
  const h = harness([pending(), pending(), pending(), { success: true, action: 'created', intentId: 'i-1' }, {}])
  const r = await createIntentFlow(WITH_ID, h.deps)
  assert.equal(r.action, 'created')
  const status = h.calls.filter(c => c.action === 'pending-intent-status')
  assert.deepEqual(status.map(c => c.data.countPoll), [true, false, false, false])
  assert.ok(status.every(c => c.data.pendingId === 'p-1' && c.data.repoOrigin === 'github.com:acme/widgets'))
})

test('a decision to create sets the intent active under this session', async () => {
  const h = harness([{ success: true, action: 'created', intentId: 'i-1' }, {}])
  const r = await createIntentFlow(WITH_ID, h.deps)
  assert.deepEqual([r.success, r.intentId], [true, 'i-1'])
  assert.deepEqual(h.calls.map(c => c.action), ['pending-intent-status', 'set-active'])
  assert.equal(h.calls[1].data.intentId, 'i-1')
})

test('a reactivated decision is reported as reactivated', async () => {
  const h = harness([{ success: true, action: 'reactivated', intentId: 'i-2' }, {}])
  assert.equal((await createIntentFlow(WITH_ID, h.deps)).action, 'reactivated')
})

test('declined tells the agent to stop all work', async () => {
  const h = harness([{ success: true, action: 'declined' }])
  const r = await createIntentFlow(WITH_ID, h.deps)
  assert.deepEqual([r.success, r.action], [false, 'declined'])
  assert.match(r.message, /Stop all work/)
  assert.equal(h.calls.length, 1, 'nothing is activated')
})

test('expired and unknown_pending say how to start over', async () => {
  for (const action of ['expired', 'unknown_pending'] as const) {
    const h = harness([{ success: true, action }])
    const r = await createIntentFlow(WITH_ID, h.deps)
    assert.equal(r.action, action)
    assert.match(r.message, /WITHOUT pendingId/)
  }
})

test('awaiting_user tells the agent to stop polling and wait for the user', async () => {
  const h = harness([{ success: true, action: 'awaiting_user', pendingId: 'p-1', pollsLeft: 0 }])
  const r = await createIntentFlow(WITH_ID, h.deps)
  assert.deepEqual([r.action, r.pollsLeft], ['awaiting_user', 0])
  assert.match(r.message, /Stop checking/)
  assert.equal(h.elapsed(), 0, 'it returns at once instead of burning 20 s')
})

// --- the deadline ------------------------------------------------------------

test('an unanswered wait ends at the 20 s wall-clock deadline with pending_approval', async () => {
  const h = harness([pending(3)])
  const r = await createIntentFlow(WITH_ID, h.deps)
  assert.equal(r.action, 'pending_approval')
  assert.equal(r.pollsLeft, 3)
  assert.match(r.message, /Checks left before you must stop and wait: 3/)
  assert.ok(h.elapsed() <= WAIT_BUDGET_MS, `took ${h.elapsed()} ms`)
  assert.ok(h.elapsed() >= WAIT_BUDGET_MS - 1_000, 'and used the budget')
  const n = h.calls.length
  assert.ok(n >= 19 && n <= 21, `about one status call a second, got ${n}`)
})

test('every status call is bounded by what is left of the budget, never more than 30 s', async () => {
  const h = harness([pending()])
  await createIntentFlow(WITH_ID, h.deps)
  for (const c of h.calls) {
    const remaining = WAIT_BUDGET_MS - (c.at - 1_000_000)
    assert.ok(c.timeoutMs! <= Math.min(remaining, MAX_STATUS_CALL_MS), `call at ${c.at} got ${c.timeoutMs}`)
    assert.ok(c.timeoutMs! > 0)
  }
  assert.equal(h.calls[0].timeoutMs, WAIT_BUDGET_MS, 'the first call may use the whole budget')
})

test('a status call that times out ends the wait as pending_approval, by the deadline', async () => {
  // Kawa Code is busy with another session's slow handler: the call burns its
  // whole timeout and gets nothing. The tool must still return by the deadline
  // — not 30 s after it — and it is not an error.
  let spent = 0
  const h = harness([(call: Call) => {
    spent = call.timeoutMs!
    return new MuninnTimeoutError(call.timeoutMs! / 1000, 'intent', 'pending-intent-status')
  }], { costMs: 0 })
  // The fake request must also cost its timeout, as a real one would.
  const base = h.deps.request
  h.deps.request = async (d, a, data, timeoutMs) => {
    try { return await base(d, a, data, timeoutMs) } finally { await h.deps.sleep(timeoutMs ?? 0) }
  }
  const r = await createIntentFlow(WITH_ID, h.deps)
  assert.equal(r.action, 'pending_approval')
  assert.equal(spent, WAIT_BUDGET_MS)
  assert.ok(h.elapsed() <= WAIT_BUDGET_MS, `took ${h.elapsed()} ms`)
})

test('a slow earlier reply leaves later calls only the time that remains', async () => {
  const h = harness([pending()], { costMs: 4_000 })
  const r = await createIntentFlow(WITH_ID, h.deps)
  assert.equal(r.action, 'pending_approval')
  assert.ok(h.elapsed() <= WAIT_BUDGET_MS + 4_000 + 1_000, `took ${h.elapsed()} ms`)
  for (const c of h.calls) assert.ok(c.timeoutMs! <= MAX_STATUS_CALL_MS)
})

test('an error that is not a timeout is raised', async () => {
  const h = harness([new Error('Muninn handler returned success: false with no error message')])
  await assert.rejects(createIntentFlow(WITH_ID, h.deps), /no error message/)
})

test('a reply it does not recognise is raised rather than guessed at', async () => {
  const h = harness([{ success: true, action: 'something-new' }])
  await assert.rejects(createIntentFlow(WITH_ID, h.deps), /Unexpected reply/)
})

test('a decision to create with no intent id is raised', async () => {
  const h = harness([{ success: true, action: 'created' }])
  await assert.rejects(createIntentFlow(WITH_ID, h.deps), /no intent ID/)
})
