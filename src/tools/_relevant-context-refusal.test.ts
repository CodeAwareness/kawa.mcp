import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectToMuninn, disconnect, RepoAccessError } from '../services/muninn-ipc.js'
import { getRelevantContext } from './get-relevant-context.js'
import { readActiveIntentResource } from '../resources/active-intent.js'

// A fake Kawa Code on a temp Unix socket: sends the handshake, then answers every
// request with whatever `reply` currently holds. MUNINN_SOCKET points the client at it,
// so the real socket is never touched.
let reply: Record<string, unknown> = {}
let server: net.Server
let dir: string

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-mcp-'))
  const sock = path.join(dir, 's')
  server = net.createServer((c) => {
    c.write(JSON.stringify({ flow: 'brdc', domain: 'system', action: 'handshake', data: { caw: 'test' } }) + '\n')
    let buf = ''
    c.on('data', (chunk) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        c.write(JSON.stringify({ flow: 'res', domain: msg.domain, action: msg.action, _msgId: msg._msgId, data: reply }) + '\n')
      }
    })
  })
  await new Promise<void>((r) => server.listen(sock, r))
  process.env.MUNINN_SOCKET = sock
  await connectToMuninn()
})

after(async () => {
  disconnect()
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

const refusal = {
  success: false,
  code: 'no_repo_access',
  accessReason: 'unsupported_host',
  error: 'No access to this repository (unsupported_host)',
}

test('get_relevant_context relays a repo-access refusal instead of an empty "unavailable" result', async () => {
  reply = refusal
  await assert.rejects(
    getRelevantContext({ repoOrigin: 'git@bitbucket.org:o/r.git', repoPath: '/x', prompt: 'p' } as any),
    (err: any) => err instanceof RepoAccessError && err.accessReason === 'unsupported_host',
  )
})

test('get_relevant_context keeps the soft result for a real outage, without naming Muninn', async () => {
  reply = { success: false, error: 'boom' }
  const res = await getRelevantContext({ repoOrigin: 'git@github.com:o/r.git', repoPath: '/x', prompt: 'p' } as any)
  assert.deepEqual(res.relevantIntents, [])
  assert.equal(res.error, 'Kawa Code unavailable: boom')
})

test('the active-intent resource relays a refusal as structured, non-retryable output', async () => {
  reply = refusal
  const out = JSON.parse(await readActiveIntentResource('git@bitbucket.org:o/r.git'))
  assert.equal(out.success, false)
  assert.equal(out.error, 'no_repo_access')
  assert.equal(out.reason, 'unsupported_host')
  assert.equal(out.retryable, false)
})

test('the active-intent resource keeps its soft note for a real failure', async () => {
  reply = { success: false, error: 'boom' }
  const out = JSON.parse(await readActiveIntentResource('git@github.com:o/r.git'))
  assert.equal(out.hasActiveIntent, false)
  assert.match(out.note, /Failed to query/)
})
