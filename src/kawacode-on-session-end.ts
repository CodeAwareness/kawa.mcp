#!/usr/bin/env node
/**
 * kawacode-on-session-end — Claude Code SessionEnd hook.
 *
 * Tells Kawa Code that this Claude Code session is over, so a request it parked
 * for the user's decision (create_and_activate_intent overlap) is not turned
 * into an intent for an agent that is no longer there. ONE IPC:
 * intent:pending-intent-session-ended { aid }. Kawa Code owns what happens next.
 *
 * `aid` is the hook payload's `session_id`: the same id the MCP stamps on every
 * request as `_agentId` (CLAUDE_CODE_SESSION_ID), so it names the same session.
 *
 * Failure discipline: every error path exits 0, as with kawacode-on-stop. The
 * hook runs while Claude Code is shutting down and must never delay or fail it;
 * if Kawa Code is down or the message is lost, the parked request simply
 * expires on its own after 24 hours.
 */

import { readFileSync } from 'node:fs'

import { connectToMuninn, request, disconnect, setQuiet } from './services/muninn-ipc.js'

// Hook stderr can surface to the user; suppress IPC lifecycle chatter.
setQuiet(!process.env.KAWA_DEBUG)

/** SessionEnd runs at shutdown under a short limit, so give up quickly. */
const SEND_TIMEOUT_MS = 1_000

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

async function main(): Promise<void> {
  let aid: string | undefined
  try {
    aid = JSON.parse(readStdin()).session_id
  } catch {
    process.exit(0)
  }
  if (!aid) process.exit(0)

  try {
    await connectToMuninn()
    await request('intent', 'pending-intent-session-ended', { aid }, SEND_TIMEOUT_MS)
  } catch {
    // Kawa Code is down or slow: nothing to do, the request expires on its own.
  }
  disconnect()
  process.exit(0)
}

main().catch(() => process.exit(0))
