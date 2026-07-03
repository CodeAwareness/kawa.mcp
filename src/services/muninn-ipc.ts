/**
 * Muninn IPC Client for MCP Server
 *
 * Connects to Muninn's Huginn IPC socket as an extension client,
 * translating MCP tool calls into domain:action IPC messages.
 *
 * Modeled after kawa.i18n/src/ipc/muninn-socket.ts but simplified:
 * - No UI bundle or manifest (MCP has no UI)
 * - Request/response correlation via _msgId
 * - 30s default timeout per request, overridable per call
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

const EXTENSION_ID = 'mcp'
const EXTENSION_DOMAINS = ['intent', 'intent-block', 'decision', 'claude-code', 'code', 'inference']

/**
 * Stable session ID for this MCP process — identifies this agent/session for
 * intent attribution AND for the per-session "current" intent pointer in Muninn
 * (IMPLEMENTATION_PLAN_MULTI_ACTIVE_INTENTS.md §2 D1).
 *
 * Prefer Claude Code's `CLAUDE_CODE_SESSION_ID`: it's the SAME id the thought-
 * capture path keys on (the `thoughts/active/session-{id}.jsonl` filename and the
 * extractor trigger), so the IPC and capture worlds converge on one value, and it
 * is stable across MCP reconnects (a fresh socket `caw` recovers the same focus).
 * Subagents share their parent session's id — there is no per-subagent id at the
 * MCP layer (see plan §11).
 *
 * Fallback: hosts that don't set the env var (Cursor/Windsurf, older Claude Code)
 * get a generated `mcp-<random>`. Those have no Claude thought-capture, so capture
 * routing is moot and the random id serves only as an IPC discriminator.
 *
 * Stamped as `_agentId` on every outgoing message (see `request()` below); Muninn
 * lifts it into `IpcMessage.aid` and keys the per-session current pointer on it.
 */
export const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || `mcp-${crypto.randomBytes(4).toString('hex')}`
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * Muninn's Tauri bundle identifier.
 * Used on macOS to locate the App Sandbox container.
 */
const MUNINN_BUNDLE_ID = 'com.codeawareness.muninn'

interface PendingRequest {
  resolve: (data: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let socket: net.Socket | null = null
let connected = false
let cawId = ''
let connectionPromise: Promise<void> | null = null
const pendingRequests = new Map<string, PendingRequest>()

/**
 * Quiet mode: suppresses connection-lifecycle info logging (connect,
 * handshake, close). Hook dispatchers enable it because Claude Code surfaces
 * hook stderr to the agent/user on exit-2 blocks — the handshake chatter
 * pollutes the actual message. Genuine error logs are never suppressed.
 * The stdio MCP server leaves this off; its stderr feeds the MCP log view.
 */
let quiet = false

export function setQuiet(value: boolean): void {
  quiet = value
}

function logInfo(message: string): void {
  if (!quiet) console.error(message)
}

/**
 * Get the default Muninn socket path for the current platform.
 */
function getDefaultMuninnSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\muninn'
  }
  if (process.platform === 'darwin') {
    // App Store (sandboxed) Muninn: socket may be inside the sandbox container
    const containerSocketPath = path.join(
      os.homedir(),
      'Library', 'Containers', MUNINN_BUNDLE_ID, 'Data',
      'Library', 'Application Support', 'Kawa Code', 'sockets', 'muninn'
    )
    if (fs.existsSync(containerSocketPath)) {
      return containerSocketPath
    }
  }
  // All platforms (incl. macOS dev/brew): ~/.kawa-code/sockets/muninn
  // Matches Muninn's paths.rs: sockets_dir().join("muninn")
  return path.join(os.homedir(), '.kawa-code', 'sockets', 'muninn')
}

/**
 * Connect to Muninn's Huginn IPC socket.
 *
 * Sends extension handshake and waits for acknowledgment.
 * Throws if Muninn is not running or handshake fails.
 */
export function connectToMuninn(socketPath?: string): Promise<void> {
  if (connectionPromise) return connectionPromise
  connectionPromise = _connectToMuninn(socketPath).finally(() => {
    connectionPromise = null
  })
  return connectionPromise
}

function _connectToMuninn(socketPath?: string): Promise<void> {
  const targetPath = socketPath || process.env.MUNINN_SOCKET || getDefaultMuninnSocketPath()

  return new Promise((resolve, reject) => {
    logInfo(`[MuninnIPC] Connecting to Muninn catalog at ${targetPath}...`)

    const catalogSock = net.createConnection(targetPath, () => {
      // Send extension handshake
      const handshake = JSON.stringify({
        domain: 'system',
        action: 'handshake',
        data: {
          clientType: 'extension',
          extensionId: EXTENSION_ID,
          domains: EXTENSION_DOMAINS,
        },
      })
      catalogSock.write(handshake + '\n')
    })

    let handshakeReceived = false
    let switchedToClientPipe = false  // Windows: true after catalog→client pipe handoff
    let buffer = ''

    catalogSock.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const msg = JSON.parse(line)

          if (!handshakeReceived && msg.domain === 'system' && msg.action === 'handshake') {
            handshakeReceived = true
            cawId = msg.data?.caw || ''

            const pipePath: string | undefined = msg.data?.pipePath

            if (pipePath) {
              // Windows two-pipe protocol: catalog pipe only handles registration.
              // Muninn sends back a dedicated client pipe path; connect to it for I/O.
              switchedToClientPipe = true
              logInfo(`[MuninnIPC] Handshake complete (caw=${cawId}), connecting to ${pipePath}`)
              catalogSock.destroy()
              // Small delay so Muninn's thread has time to start the client pipe server
              setTimeout(() => connectClientPipe(pipePath, resolve, reject), 50)
            } else {
              // Unix: single persistent connection, keep using catalogSock
              socket = catalogSock
              connected = true
              logInfo(`[MuninnIPC] Handshake complete (caw=${cawId})`)
              resolve()
            }
            continue
          }

          // Unix path: responses arrive on the same socket
          routeResponse(msg)
        } catch {
          // Ignore non-JSON lines
        }
      }
    })

    catalogSock.on('error', (err: Error) => {
      console.error(`[MuninnIPC] Catalog socket error: ${err.message}`)
      if (!handshakeReceived) {
        reject(new Error(
          `Muninn is not running. Please start Muninn first.\n` +
          `(Could not connect to ${targetPath}: ${err.message})`
        ))
      }
      if (!switchedToClientPipe) cleanup()
    })

    catalogSock.on('close', () => {
      // On Windows the catalog pipe closes after handshake — expected, skip cleanup.
      // On Unix the catalog socket IS the main socket, so closing means disconnected.
      if (!switchedToClientPipe) {
        logInfo('[MuninnIPC] Socket closed')
        cleanup()
      }
    })

    // Handshake timeout
    setTimeout(() => {
      if (!handshakeReceived) {
        catalogSock.destroy()
        reject(new Error('Muninn handshake timeout (10s). Is Muninn running?'))
      }
    }, HANDSHAKE_TIMEOUT_MS)
  })
}

/**
 * Connect to the dedicated client pipe returned in the Windows handshake.
 * On Windows, Muninn creates a per-client named pipe (\\.\pipe\caw.<id>)
 * for bidirectional communication after the catalog registration.
 */
function connectClientPipe(
  pipePath: string,
  resolve: () => void,
  reject: (err: Error) => void
): void {
  logInfo(`[MuninnIPC] Connecting to client pipe: ${pipePath}`)

  const clientSock = net.createConnection(pipePath, () => {
    socket = clientSock
    connected = true
    logInfo('[MuninnIPC] Client pipe connected')
    resolve()
  })

  let buffer = ''

  clientSock.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { routeResponse(JSON.parse(line)) } catch { /* ignore */ }
    }
  })

  clientSock.on('error', (err: Error) => {
    console.error(`[MuninnIPC] Client pipe error: ${err.message}`)
    if (!connected) {
      reject(new Error(`Failed to connect to Muninn client pipe: ${err.message}`))
    }
    cleanup()
  })

  clientSock.on('close', () => {
    logInfo('[MuninnIPC] Client pipe closed')
    cleanup()
  })
}

/** Route an inbound response message to its waiting pendingRequest entry.
 *
 * Failure propagation has two layers:
 *   1. Envelope-level: `msg.err` is set when the IPC dispatch itself failed
 *      (unknown domain, malformed message, etc.). Reject directly.
 *   2. Application-level: Muninn handlers wrap their own failures INSIDE
 *      `msg.data` as `{ success: false, error: "..." }`. Without this check,
 *      tools silently received the failure object as a successful resolve and
 *      had to remember to inspect it themselves — which several built tools
 *      did not, leading to fake `success: true, intentId: ""` responses.
 *
 * Strict equality (`=== false`) is intentional. Async-start responses such as
 * `{ started: true, message: "..." }` (inference run/evolve) and estimate
 * responses (`{ estimate: {...} }`) carry no `success` field at all and must
 * pass through unchanged.
 */
function routeResponse(msg: any): void {
  const msgId = msg._msgId
  if (msgId && pendingRequests.has(msgId)) {
    const pending = pendingRequests.get(msgId)!
    pendingRequests.delete(msgId)
    clearTimeout(pending.timer)
    if (msg.err) {
      pending.reject(new Error(msg.err))
      return
    }
    const data = msg.data || {}
    if (data.success === false) {
      // Some handlers return structured failure shapes the calling tool is
      // designed to interpret and present — these are data, not dispatch
      // failures, so resolve (don't reject) and let the tool layer handle them:
      //   - create_and_activate_intent similarity conflicts: { conflict: true, conflicts: [...] }
      //   - complete_intent distillation conflicts:          { reason: "conflicts", conflicts: [...] }
      //   - complete_intent transient failures:              { reason: "transient-failure", error, failedStage }
      // Without this, complete_intent's conflict shape (no `conflict` flag, no
      // `error` field) fell through to the generic reject below and surfaced as
      // the opaque "no error message" — bypassing complete-intent.ts's
      // conflict-surfacing logic entirely.
      if (data.conflict === true || typeof data.reason === 'string' || Array.isArray(data.conflicts)) {
        pending.resolve(data)
        return
      }
      const errorMsg = typeof data.error === 'string' && data.error.length > 0
        ? data.error
        : 'Muninn handler returned success: false with no error message'
      pending.reject(new Error(errorMsg))
      return
    }
    pending.resolve(data)
  }
}

/**
 * Send an IPC request to Muninn and await the correlated response.
 *
 * @param domain    - Handler domain (e.g., 'intent', 'decision')
 * @param action    - Handler action (e.g., 'create', 'get-active')
 * @param data      - Request payload
 * @param timeoutMs - Per-call timeout override. Defaults to 30s, which is the
 *                    right fast-fail ceiling for synchronous handlers. A few
 *                    synchronous endpoints (e.g., inference:estimate on deep
 *                    repos) legitimately run longer — callers raise it
 *                    explicitly rather than relaxing the global default.
 * @returns The response data from Muninn
 */
export async function request(
  domain: string,
  action: string,
  data: any = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<any> {
  if (!socket || !connected) {
    await connectToMuninn()
  }

  const msgId = `mcp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(msgId)
      reject(new Error(`Muninn request timeout (${timeoutMs / 1000}s): ${domain}:${action}`))
    }, timeoutMs)

    pendingRequests.set(msgId, { resolve, reject, timer })

    const message = JSON.stringify({
      flow: 'req',
      domain,
      action,
      caw: cawId,
      data: { ...data, _agentId: SESSION_ID },
      _msgId: msgId,
    })

    socket!.write(message + '\n')
  })
}

/**
 * Ensure a repository path is registered with Muninn as a project.
 *
 * Sends `code:add` with the folder path so Muninn activates the project,
 * sets up git state, and pulls intents/decisions from the API.
 * Always sends the request — Muninn's AddHandler is idempotent and
 * returns the existing project if already added.
 * Errors are logged but not thrown — repo registration is best-effort.
 */
export async function ensureRepo(repoPath: string): Promise<void> {
  try {
    await request('code', 'add', { folder: repoPath })
  } catch (err) {
    console.error(`[MuninnIPC] ensureRepo failed for ${repoPath}: ${(err as Error).message}`)
  }
}

/**
 * Check if connected to Muninn.
 */
export function isConnected(): boolean {
  return connected
}

/**
 * Disconnect from Muninn.
 */
export function disconnect(): void {
  if (socket) {
    socket.destroy()
  }
  cleanup()
}

function cleanup(): void {
  connected = false
  socket = null
  connectionPromise = null

  // Reject all pending requests
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Muninn connection closed'))
  }
  pendingRequests.clear()
}
