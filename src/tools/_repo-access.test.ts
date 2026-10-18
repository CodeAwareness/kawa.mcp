import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RepoAccessError,
  repoAccessToolOutput,
  routeResponse,
  pendingRequests,
} from '../services/muninn-ipc.js'

/** Register a pending request, route `data` to it, and report how it settled. */
async function settle(data: unknown, envelope: Record<string, unknown> = {}) {
  const id = `test-${Math.random().toString(36).slice(2)}`
  const outcome = new Promise<{ resolved?: any; rejected?: any }>((resolve) => {
    pendingRequests.set(id, {
      resolve: (v: any) => resolve({ resolved: v }),
      reject: (e: any) => resolve({ rejected: e }),
      timer: setTimeout(() => {}, 0),
    } as any)
  })
  routeResponse({ _msgId: id, data, ...envelope })
  return outcome
}

test('a no_repo_access refusal rejects with a typed RepoAccessError', async () => {
  const { rejected, resolved } = await settle({
    success: false,
    code: 'no_repo_access',
    accessReason: 'app_not_installed',
    error: 'Install the Kawa Code GitHub App.',
  })
  assert.equal(resolved, undefined)
  assert.ok(rejected instanceof RepoAccessError)
  assert.equal(rejected.code, 'no_repo_access')
  assert.equal(rejected.accessReason, 'app_not_installed')
  assert.equal(rejected.message, 'Install the Kawa Code GitHub App.')
})

test('a refusal that also carries a string `reason` is still rejected, never resolved as data', async () => {
  const { rejected, resolved } = await settle({
    success: false,
    code: 'no_repo_access',
    reason: 'app_not_installed',
    accessReason: 'app_not_installed',
    error: 'refused',
  })
  assert.equal(resolved, undefined)
  assert.ok(rejected instanceof RepoAccessError)
})

test('the tool output is structured and non-retryable', () => {
  const out = repoAccessToolOutput(new RepoAccessError('refused.', 'app_not_installed'), 'check_active_intent')
  assert.equal(out.success, false)
  assert.equal(out.error, 'no_repo_access')
  assert.equal(out.reason, 'app_not_installed')
  assert.equal(out.retryable, false)
  assert.equal(out.tool, 'check_active_intent')
  assert.match(out.message, /refused\./)
})

test('the tool output separates the refusal text from the instruction, whatever the text ends with', () => {
  const noStop = repoAccessToolOutput(new RepoAccessError('No access (unsupported_host)', 'unsupported_host'), 't')
  assert.match(noStop.message, /^No access \(unsupported_host\)\. Do not retry\./)
  const stop = repoAccessToolOutput(new RepoAccessError('Install the App. ', 'app_not_installed'), 't')
  assert.match(stop.message, /^Install the App\. Do not retry\./)
})

test('conflicts, frozen and transient-failure shapes still resolve as data', async () => {
  const shapes = [
    { success: false, conflict: true, conflicts: [{ intentId: 'a' }] },
    { success: false, reason: 'conflicts', conflicts: [{ id: 'b' }] },
    { success: false, reason: 'transient-failure', error: 'x', failedStage: 'blocks' },
    { success: false, frozen: true, error: 'frozen' },
  ]
  for (const shape of shapes) {
    const { resolved, rejected } = await settle(shape)
    assert.equal(rejected, undefined)
    assert.deepEqual(resolved, shape)
  }
})

test('a success:false without code still rejects with its error text', async () => {
  const { rejected } = await settle({ success: false, error: 'API down' })
  assert.ok(rejected instanceof Error)
  assert.ok(!(rejected instanceof RepoAccessError))
  assert.equal(rejected.message, 'API down')
})

test('a success response resolves unchanged', async () => {
  const { resolved } = await settle({ success: true, intent: { id: 'i' } })
  assert.deepEqual(resolved, { success: true, intent: { id: 'i' } })
})

// kawacode-on-stop wraps every request() in a catch that returns null / exits 0
// (main().catch(() => process.exit(0))). A refusal is an ordinary rejected
// promise, so it must take that same fail-open path and never escape.
test('a refusal rejection is absorbed by the Stop hook fail-open pattern', async () => {
  const gate = async () => {
    try {
      await new Promise((_, reject) => {
        const id = `stop-${Math.random().toString(36).slice(2)}`
        pendingRequests.set(id, { resolve: () => {}, reject, timer: setTimeout(() => {}, 0) } as any)
        routeResponse({ _msgId: id, data: { success: false, code: 'no_repo_access', accessReason: 'x', error: 'no' } })
      })
      return 'unexpected'
    } catch {
      return null // fail open, no gate
    }
  }
  assert.equal(await gate(), null)
})
