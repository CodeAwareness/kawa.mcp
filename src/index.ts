#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js'

import { connectToMuninn, disconnect, ensureRepo } from './services/muninn-ipc.js'
import { resolveMangledArgs, describeChainedArgs } from './tools/_mangled-args.js'

import {
  allTools,
  getRelevantContext,
  checkActiveIntent,
  createAndActivateIntent,
  activateIntent,
  resumeIntent,
  getIntentsForFile,
  listTeamIntents,
  completeIntent,
  updateIntent,
  logWork,
  recordDecision,
  getSessionDecisions,
  getProjectDecisions,
  getDecisionDetail,
  editSessionDecision,
  detectIntentConflicts,
  inferHistory,
  getResolutionContext,
  arbiterResolve,
  arbiterApply
} from './tools/index.js'
import { prompts, intentFirstWorkflowPrompt } from './prompts/intent-first-workflow.js'
import { resources, readActiveIntentResource } from './resources/active-intent.js'

// Create MCP server
const server = new Server(
  {
    name: 'kawa-intents',
    version: '0.3.0'
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {}
    }
  }
)

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(tool.inputSchema.shape).map(([key, value]) => [
            key,
            {
              ...getZodSchema(value),
              description: (value as any)._def?.description || ''
            }
          ])
        ),
        required: Object.entries(tool.inputSchema.shape)
          .filter(([_, value]) => isRequired(value))
          .map(([key]) => key)
      }
    }))
  }
})

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params

  // A malformed tool-call block (a parameter closed with `</fieldName>` instead
  // of the required closing tag, followed by one opened without the required
  // prefix) makes the harness fold the next field's name AND value into the
  // preceding string. One seam covers every tool. A single absorbed field is
  // put back mechanically; a chain is refused rather than reconstructed, so the
  // model re-emits. Both outcomes are logged. See _mangled-args.ts.
  let args = rawArgs
  const schema = allTools.find(t => t.name === name)?.inputSchema
  if (args && typeof args === 'object' && schema) {
    const { args: repaired, salvaged, chained } = resolveMangledArgs(
      args as Record<string, unknown>,
      Object.keys(schema.shape),
    )
    if (chained.length > 0) {
      const message = describeChainedArgs(name, chained)
      // stderr only — stdout is the MCP transport.
      console.error(`[MuninnIPC] ${message}`)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: message, tool: name }, null, 2),
          },
        ],
        isError: true,
      }
    }
    if (salvaged.length > 0) {
      args = repaired
      console.error(
        `[MuninnIPC] Recovered ${salvaged.length} malformed argument(s) for ${name}: ` +
          salvaged.map(s => `${s.field} (absorbed by ${s.fromField})`).join(', '),
      )
    }
  }

  try {
    const repoPath = (args as any)?.repoPath
    if (repoPath) {
      await ensureRepo(repoPath)
    }

    let result: any

    switch (name) {
      case 'get_relevant_context':
        result = await getRelevantContext(args as any)
        break
      case 'check_active_intent':
        result = await checkActiveIntent(args as any)
        break
      case 'create_and_activate_intent':
        result = await createAndActivateIntent(args as any)
        break
      case 'activate_intent':
        result = await activateIntent(args as any)
        break
      case 'resume_intent':
        result = await resumeIntent(args as any)
        break
      case 'get_intents_for_file':
        result = await getIntentsForFile(args as any)
        break
      case 'list_team_intents':
        result = await listTeamIntents(args as any)
        break
      case 'complete_intent':
        result = await completeIntent(args as any)
        break
      case 'update_intent':
        result = await updateIntent(args as any)
        break
      case 'log_work':
        result = await logWork(args as any)
        break
      case 'record_decision':
        result = await recordDecision(args as any)
        break
      case 'get_session_decisions':
        result = await getSessionDecisions(args as any)
        break
      case 'get_project_decisions':
        result = await getProjectDecisions(args as any)
        break
      case 'get_decision_detail':
        result = await getDecisionDetail(args as any)
        break
      case 'edit_session_decision':
        result = await editSessionDecision(args as any)
        break
      case 'detect_intent_conflicts':
        result = await detectIntentConflicts(args as any)
        break
      case 'infer_history':
        result = await inferHistory(args as any)
        break
      case 'get_resolution_context':
        result = await getResolutionContext(args as any)
        break
      case 'arbiter_resolve':
        result = await arbiterResolve(args as any)
        break
      case 'arbiter_apply':
        result = await arbiterApply(args as any)
        break
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  } catch (error) {
    // Surface IPC / handler failures as structured tool output instead of an
    // McpError stack trace. The AI sees the friendly error message and can
    // decide how to recover (retry, fall back, ask user, etc.).
    // Errors that are not IPC-related (e.g. unknown tool name) are still
    // raised as McpError below.
    if (error instanceof McpError) throw error
    const message = error instanceof Error ? error.message : 'Tool execution failed'
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: message,
            tool: name,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
})

// Handle prompt listing
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: prompts.map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments
    }))
  }
})

// Handle prompt retrieval
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  const prompt = prompts.find(p => p.name === name)
  if (!prompt) {
    throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`)
  }

  return {
    description: prompt.description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: prompt.getPrompt(args as any)
        }
      }
    ]
  }
})

// Handle resource listing
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: resources.map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType
    }))
  }
})

// Handle resource reading
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params

  if (uri === 'kawa://intent/active') {
    const content = await readActiveIntentResource()
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: content
        }
      ]
    }
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`)
})

// Helper to convert Zod types to JSON Schema property objects
function getZodSchema(zodType: any): Record<string, any> {
  const typeName = zodType._def?.typeName
  switch (typeName) {
    case 'ZodString':
      return { type: 'string' }
    case 'ZodNumber':
      return { type: 'number' }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodArray':
      return { type: 'array', items: getZodSchema(zodType._def.type) }
    case 'ZodObject':
      return { type: 'object' }
    case 'ZodEnum':
      return { type: 'string', enum: zodType._def.values }
    case 'ZodOptional':
    case 'ZodDefault':
      return getZodSchema(zodType._def.innerType)
    case 'ZodAny':
    case 'ZodUnknown':
    case 'ZodRecord':
      return { type: 'object' }
    default:
      return { type: 'string' }
  }
}

function isRequired(zodType: any): boolean {
  const typeName = zodType._def?.typeName
  return typeName !== 'ZodOptional' && typeName !== 'ZodDefault'
}

/**
 * Terminate the server process, closing the Muninn socket on the way out.
 *
 * Until this existed the process had NO self-exit path at all. The SDK's
 * `StdioServerTransport.close()` only calls `_stdin.pause()` and fires
 * `onclose?.()` — it never exits — and the Muninn socket is a live handle that
 * pins libuv's event loop indefinitely, so nothing ended the process except the
 * parent killing it. A parent that dies without getting to that (SIGKILL,
 * crash, force-quit) left the server running until reboot.
 *
 * That is worse than a stray process: the leaked server keeps its Muninn socket
 * CONNECTED, so Muninn never observes a disconnect. The referenced-entities
 * surface (DECISION_LINKING §6.8D) evicts a session's group on socket loss, and
 * a leak defeats that in exactly the case eviction exists for.
 *
 * Idempotent: `onclose` and a signal can both fire for one shutdown.
 */
let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`Kawa Intents MCP Server shutting down (${reason})`)
  try {
    // Closes the socket so Muninn sees the disconnect promptly, and rejects any
    // in-flight requests rather than leaving their promises dangling.
    disconnect()
  } catch (err) {
    console.error(`Shutdown teardown failed: ${(err as Error).message}`)
  }
  process.exit(0)
}

// Main entry point
async function main() {
  // Log to stderr (stdout is reserved for MCP protocol)
  console.error('Kawa Intents MCP Server starting (Muninn IPC mode)...')

  // Connect to Muninn before starting MCP transport
  try {
    await connectToMuninn()
    console.error('Connected to Muninn')
  } catch (err) {
    console.error(`Warning: ${(err as Error).message}`)
    console.error('MCP server will start but tools will fail until Muninn is running.')
  }

  // Start the stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // The MCP stdio contract's shutdown signal is the client closing our stdin.
  //
  // ⚠️ `StdioServerTransport` does NOT implement it. Read its `start()`: it
  // registers `data` and `error` on stdin and nothing else — no `end`, no
  // `close`. So `transport.close()` is never called on EOF, `onclose` never
  // fires, and a server that waits for it waits forever. Verified against
  // @modelcontextprotocol/sdk's `server/stdio.js` after `server.onclose` alone
  // failed to exit in testing. Every stdio server on this SDK has to wire EOF
  // itself; there is no built-in path.
  //
  // This also covers an abruptly-killed parent: the kernel closes the dead
  // parent's write end of the stdin pipe and the read end EOFs. Verified on the
  // real `parent -> npm exec -> node` topology with SIGKILL, through the npm
  // wrapper layer — which is why no `ppid` watchdog is needed.
  process.stdin.on('end', () => shutdown('stdin closed'))
  process.stdin.on('close', () => shutdown('stdin closed'))

  // Distinct trigger, same action: something closed the transport
  // programmatically. `Protocol.connect()` wraps `transport.onclose` and
  // forwards here after its own cleanup, so this is the supported attachment
  // point — assigning `transport.onclose` post-connect would clobber that
  // wrapper. This is not a fallback for the EOF path above; it is a different
  // event that also means "stop serving".
  server.onclose = () => shutdown('stdio transport closed')

  // Not needed to *terminate* — default disposition already does that — but it
  // closes the Muninn socket cleanly instead of leaving Muninn to notice a
  // half-open connection.
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.error('Kawa Intents MCP Server running')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
