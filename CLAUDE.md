# CLAUDE.md — kawa.mcp

Guidance for Claude Code when working in this repository.

**kawa.mcp** is the `kawa-intents` MCP server (npm: `@kawacode/mcp`). It exposes intent tracking, decision recording, and team-coordination tools to AI coding assistants (Claude Code, Cursor, etc.) by proxying over IPC to the Kawa Code desktop app (Muninn).

The server itself owns no business logic — every tool is a thin adapter that forwards to Muninn over Unix sockets / named pipes. The interesting algorithms (intent management, decision evolution, conflict detection) live in `kawa.muninn` (closed-source).

---

## Workflow — run on every non-trivial turn

Follow the standard Kawa Code workflow defined in the parent [Odin CLAUDE.md](../CLAUDE.md):

1. `check_active_intent` — resume if one exists.
2. `get_relevant_context` with a task description.
3. Now explore code, read files, plan.
4. Create an intent when transitioning to actual code changes.
5. Before commit — `record_decision` for significant decisions.
6. After commit — `complete_intent` with the commit SHA and `status: "committed"`.

Use `repoOrigin: git@github.com:kawacode-ai/kawa.mcp.git` and `repoPath: /Users/markvasile/Code/CodeAwareness/Odin/kawa.mcp`.

---

## Build & Development

```bash
yarn build             # tsc → build/
yarn dev               # tsc --watch
yarn start             # node build/index.js (stdio MCP server)
yarn clean             # rm -rf build
./deploy.sh            # publish to npm + MCP Registry (see ## Deploy below)
```

`prepublishOnly` runs `yarn build` automatically — never publish without a fresh build.

---

## CRITICAL: Version sync invariant

Three places must always carry the same version string, or `deploy.sh` and the MCP registry will reject the publish:

1. `package.json` → `version`
2. `server.json` → `version` (top-level)
3. `server.json` → `packages[0].version`

When bumping the version, update all three in one commit. Don't ship one without the others.

---

## Deploy

`./deploy.sh [patch|minor|major | --no-bump]` ships a new version to **both** npm and the [MCP Registry](https://registry.modelcontextprotocol.io). Defaults to a patch bump.

Use `--no-bump` when the version was already bumped in a prior commit — e.g. a semver-breaking change committed alongside the work that requires it. The script reads the existing version from `package.json`, still runs the server.json sync (healing any drift), then proceeds with validate + publish.

### Pipeline (in order)

1. **Pre-flight** — fail if `mcp-registry-key.pem` or the `mcp-publisher` CLI is missing.
2. **Build** — clean + `tsc`.
3. **Bump** — `npm version <bump> --no-git-tag-version`.
4. **Sync** — `server.json` top-level `version` and `packages[0].version` updated to match `package.json` (see version sync invariant above).
5. **Validate** — `mcp-publisher validate` checks `server.json` against the live registry schema. Catches errors before any publish lands. Note the registry caps `description` at **100 chars**.
6. **npm publish** — `--access public`.
7. **Registry auth** — DNS-method, Ed25519, against `kawacode.ai`. The script extracts the raw 32-byte private key from the PEM with:
   ```bash
   openssl pkey -in mcp-registry-key.pem -outform DER | tail -c 32 | xxd -p -c 64
   ```
   **Important**: macOS `/usr/bin/openssl` is LibreSSL and does not support Ed25519 — it will fail with `unsupported algorithm`. `deploy.sh` auto-detects a real OpenSSL (prefers `openssl@3` from Homebrew). For manual invocations, use the full path, e.g. `/opt/homebrew/opt/openssl@3/bin/openssl`.

   That hex string is passed to `mcp-publisher login dns --domain kawacode.ai --private-key <hex> --algorithm ed25519`.
8. **Registry publish** — `mcp-publisher publish` (reads `./server.json`).
9. **Commit + tag** — once both publishes succeed, commits the version-bump files (`package.json` + `server.json`) as `chore: release vX.Y.Z` and creates an annotated `vX.Y.Z` tag. Idempotent: skips the commit when nothing is staged (e.g. `--no-bump` where the version was already committed) and skips the tag when it already exists. **Not pushed** — pushing is deliberate and separate: `git push && git push origin vX.Y.Z` when ready (push-only-when-asked). Only the version-bump files are staged, so unrelated uncommitted work is left untouched — commit feature code *before* deploying.

### Prerequisites (one-time setup)

- **`mcp-publisher`** installed: `brew install mcp-publisher`.
- **`mcp-registry-key.pem`** present in repo root. Git-ignored. Recover from backup if missing — do **not** regenerate; the public key is registered in DNS against `kawacode.ai`.
- **DNS TXT record** on `kawacode.ai` paired with the public key. If missing or rotated, registry login fails at step 7 — `mcp-publisher login dns` reports the expected record content on first failure.

### Recovery from half-published state

If npm publish succeeds but registry publish fails (network, expired DNS record, etc.), npm has the new version while the registry doesn't. Fix the underlying cause, then re-run **only** the auth + publish steps manually:

```bash
# Use Homebrew's openssl@3 — /usr/bin/openssl is LibreSSL and cannot read Ed25519.
PRIVATE_KEY_HEX=$(/opt/homebrew/opt/openssl@3/bin/openssl pkey -in mcp-registry-key.pem -outform DER | tail -c 32 | xxd -p -c 64)
mcp-publisher login dns --domain kawacode.ai --private-key "$PRIVATE_KEY_HEX" --algorithm ed25519
mcp-publisher publish
```

Do **not** re-run `./deploy.sh` — `npm publish` rejects re-publishing the same version, and `npm version` would bump again unnecessarily.

---

## Architecture

### Stdio MCP server
- `src/index.ts` — `Server` from `@modelcontextprotocol/sdk`. Registers tools, prompts, resources. Connects to Muninn via `connectToMuninn()` before accepting MCP traffic.
- Stdout is reserved for MCP protocol — **all logging must go to stderr** (`console.error`). A stray `console.log` will corrupt the MCP transport and the client will disconnect.

### Tool layer (`src/tools/`)
One file per tool. Each tool:
1. Validates input with a Zod schema.
2. Calls `muninn-ipc.ts` to forward the request to Muninn.
3. Returns the result as the tool's `content` payload.

Tools are aggregated in `src/tools/index.ts` via `allTools` and individual exports — both must be updated when adding or removing a tool.

### IPC layer (`src/services/muninn-ipc.ts`)
Single client — owns the socket connection lifecycle, message framing, and `ensureRepo(repoPath)` which the dispatcher in `index.ts` calls before any tool that targets a repository.

### Other surfaces
- `src/prompts/` — MCP prompts (e.g. `intentFirstWorkflowPrompt`).
- `src/resources/` — MCP resources (e.g. `kawa://intent/active`).
- `src/extract-trigger.ts` + `bin: kawacode-extract-trigger` — CLI helper (separate binary).
- `src/pre-edit-decision-check-hook.ts` + `bin: kawacode-pre-edit-decision-check` — PreToolUse Stop-hook CLI.

---

## Adding a new tool

1. Create `src/tools/<tool-name>.ts` with a Zod input schema, a handler function, and an `export const <toolName>Tool = { name, description, inputSchema }`.
2. Add a case to the dispatcher switch in `src/index.ts`.
3. Re-export the handler and tool from `src/tools/index.ts`.
4. Add an entry to `LLM_RULES.md` — it's the public reference clients pull from.
5. If the tool ships any user-facing description text that explains an algorithm (e.g. evolve_decisions), keep it generic — the algorithm itself is a trade secret living in Muninn.

---

## Naming conventions

Public surface uses **"Kawa Code"** (the product). Internal IPC peer is referred to as **Muninn** in source code and comments — that name is acceptable here because the file is repository-local. Do not leak `Muninn` into tool descriptions or error messages shown to LLMs/users.

---

## Gotchas

- **No console.log on stdout** — corrupts MCP protocol. Always `console.error`.
- **Muninn must be running** for tools to succeed. The server still starts if Muninn is unavailable; tool calls will return structured `{ success: false, error }` payloads (see `index.ts:160-178`). Do not throw `McpError` for IPC failures — surface them as tool output so the LLM can recover.
- **Trade-secret boundary**: tool *descriptions* are public (registry-indexed). Algorithm details (decision evolution graph, semantic commit grouping, anchor computation) belong in Muninn, never inlined here.
- **`mcp-registry-key.pem`** is git-ignored and used by `deploy.sh` to sign registry submissions. If it's missing, deploys will fail — recover from a backup, do not regenerate.
- **MCP SDK quirks**: the dispatcher converts Zod schemas to JSON Schema by hand (`getZodSchema` in `index.ts`). Adding new Zod types (e.g. `ZodUnion`, `ZodLiteral`) requires extending that function or the LLM client will see `type: 'string'` for everything.

---

## Reference

- [LLM_RULES.md](./LLM_RULES.md) — public setup guide for end-users wiring this MCP into their projects. Update it when tools change.
- [CLAUDE.md.example](./CLAUDE.md.example) — template `CLAUDE.md` shipped to consumers; mirrors the setup flow in `LLM_RULES.md`.
- [server.json](./server.json) — MCP registry manifest.
