# Setup Kawa Code for any LLM

Guidelines for setting up the intent-aware AI coding workflow in any project.

## Overview

This workflow enables:
- **Persistent AI reasoning context**: Never lose track of what you were working on across sessions
- **Intent tracking**: Know what you're working on and why
- **Team visibility**: See what teammates are working on, detect conflicts
- **Decision tracking**: Record architectural decisions and trade-offs
- **Smart context retrieval**: Only fetch context relevant to the current task
- **Streamlined commits**: Automatic commit prompts when switching tasks
- **Code attribution**: Link commits to intents for better history

## Prerequisites

1. **Kawa Code Desktop App** — Running in the background for git operations, storage, and API communication
2. **Kawa MCP Server** — Install and configure the `kawa-intents` MCP server (see below)
3. **Git repository** — The project must be a git repo

## Setup Steps

### 1. Install the MCP Server

#### Claude Code

Add globally (available across all your projects):

```bash
claude mcp add kawa-intents --scope user -- npx -y @kawacode/mcp
```

Or for a single project, create a `.mcp.json` file in your project root (recommended for teams — commit it to git):

```json
{
  "mcpServers": {
    "kawa-intents": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kawacode/mcp"]
    }
  }
}
```

#### Cursor AI

Add to your Cursor MCP configuration (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "kawa-intents": {
      "command": "npx",
      "args": ["-y", "@kawacode/mcp"]
    }
  }
}
```

#### Other LLMs with MCP support

Add the `kawa-intents` MCP server to your tool's MCP configuration. The server command is:

```
npx -y @kawacode/mcp
```

### 2. Create Project CLAUDE.md

#### Quick setup (Claude Code)

Tell Claude Code:

```
Read https://raw.githubusercontent.com/kawacode-ai/kawa.mcp/main/CLAUDE.md.example and create a CLAUDE.md in this project's root from it. Fill in the repoOrigin and repoPath with the actual values from this repository's git config. Fill in the Project Overview with a brief description of this project.
```

#### Manual setup

Create a `CLAUDE.md` file in your project root with the workflow instructions. Copy and adapt the "AI Code Implementation Workflow" section below.

### 3. Configure Repository Origin

Identify your repository's git origin:
```bash
git remote get-url origin
```

Use this origin in all MCP tool calls (e.g., `git@github.com:yourorg/yourrepo.git`).

---

## AI Code Implementation Workflow

Add this section to your project's `CLAUDE.md`:

```markdown
## AI Code Implementation Workflow

When implementing code changes in this repository, follow the intent-aware workflow.

### Starting Work

**BEFORE exploring code or reading files** for any non-trivial task, follow these steps in order:

1. **Check active intent**: Call `check_active_intent` to see if work is already tracked
2. **Get relevant context**: Call `get_relevant_context` with a description of the task to find past decisions and related intents that may inform your approach
3. **Then explore code**: Now read files, search the codebase, and analyze the problem

For trivial one-line fixes (typos, obvious bugs), skip the above and use `log_work` after completing the change.

### Context Switch Detection

On each new user message, evaluate whether it relates to the active intent:

| Request Type | Action |
|-------------|--------|
| Continuation of current work | Continue under same intent |
| Clarifying question | Answer, stay on intent |
| Bug fix for work just completed | Continue under same intent |
| Refinement/improvement | Continue under same intent |
| **Clearly different feature or task** | **Trigger commit prompt** |
| **"Now let's work on X" (new topic)** | **Trigger commit prompt** |
| Non-code request (chat, questions) | Respond normally, no action |
| Explicit "let's commit" or "we're done" | Proceed to commit flow |
| Explicit "abandon this" | Call `complete_intent` with status='abandoned' |

**Default behavior**: When uncertain, continue under the current intent.

### Commit Prompt

When detecting a context switch:

> "You have uncommitted work on **'[intent title]'** ([N] files changed). This new request appears to be a different task. Would you like to:
> 1. **Commit** the current work first, then start on the new task
> 2. **Continue** - this is actually related to the current intent
> 3. **Abandon** the current work without committing"

### Recording Decisions Before Commit

When the user asks to finalize/commit, review the work done in the session and call `record_decision` for each significant decision *before* creating the commit. Apply a **high bar**: a decision is worth recording only if a future developer would genuinely benefit from knowing it.

Record when you:
- Chose between meaningful alternatives (type: `fork`)
- Discovered non-obvious behavior that will recur (type: `discovery`)
- Identified a hard constraint that future work must respect (type: `constraint`)
- Made an explicit trade-off with lasting impact (type: `tradeoff`)
- Tried and rejected an approach that looked reasonable (type: `abandoned`)
- Selected a library or dependency after comparing alternatives (type: `dependency`)

Do NOT record routine refactors, obvious bug fixes, version bumps, or formatting changes.

### Referring to Intents and Decisions

**Never refer to an intent or decision by ID alone in anything the user reads.** Lead with the title or summary, and **always** carry the ID in parentheses after it. The parenthesised ID is load-bearing, not decoration — it is the anchor Kawa Code matches to resolve the reference.

- **Decisions** — an 8-char prefix is fine: `"Summary text" (7a7d1a36)`
- **Intents** — use the **full 24-character ID**, never a prefix: `"Intent title" (6a34c9658212aa730480e0e6)`

The asymmetry is unavoidable. Decision IDs are UUIDs, so their leading bits are uniformly random and an 8-char prefix identifies exactly one decision. Intent IDs are MongoDB ObjectIds, whose first 4 bytes are a **creation timestamp** — two intents created in the same second by the same process share their first 18 hex characters. A truncated intent ID is not merely collision-prone; it does not identify a single intent at all.

So instead of:

> ❌ `7a7d1a36 supersedes 2cc444ec, which superseded 97c701e7`

write:

> ✅ `"Bare-id lineage is unreadable" (7a7d1a36) supersedes "Force-bypass on retarget" (2cc444ec)`

The references you need come pre-resolved. `get_decision_detail` returns `supersededDecisions[]` (each with `summary` and a `depth`: 1 = directly superseded, 2 = what *that* one superseded) and `intents[]` with titles — so there is no extra lookup to make.

The same rule applies when passing IDs *back in*: `record_decision(supersedes: […])` requires **full** decision IDs. A truncated prefix is rejected, because resolving it would mean guessing which decision you meant. If you only have a prefix — read out of a document, say — resolve it with `get_decision_detail` first.

### Commit Flow

When committing:

1. Run `git status` to see modified files
2. Call `assign_blocks_to_intent` with all modified file ranges
3. Execute git commit:
   ```bash
   git add <files>
   git commit -m "<intent title>

   <description>

   Intent-ID: <intent-id>
   Co-Authored-By: Claude <noreply@anthropic.com>"
   ```
4. Call `complete_intent` with commit SHA and status='committed'

### Pre-existing Uncommitted Changes

When uncommitted changes exist that weren't made under an active intent, infer intents retroactively: read the diffs, group changes by semantic purpose, call `list_team_intents` to find existing intents that match each group, then commit each group under its matched intent (create a new intent if no match found). Present the grouping plan to the user before committing. Use `log_work` for trivial standalone changes.

### MCP Tools Reference

#### Context & Discovery

| Tool | Purpose |
|------|---------|
| `get_relevant_context` | Get context relevant to a specific task (intents, decisions) |
| `get_decision_detail` | Expand one decision (by `decisionId`) to its full rationale/context/consequences/alternatives |

> **Lean recall contract.** `get_relevant_context`, `get_project_decisions`, and `get_session_decisions` return decisions **summary-only** — they omit the full `rationale` (and `context`/`consequences`/`alternatives`) to keep context lean, since MCP results are re-sent every turn. When you need the full reasoning for a specific decision, call `get_decision_detail(decisionId)` to expand just that one.

#### Intent Management

| Tool | Purpose |
|------|---------|
| `check_active_intent` | Check for active intent before starting work |
| `create_and_activate_intent` | Create new intent for a task |
| `resume_intent` | Resume an existing intent by id in one call (activate + load its decisions) — use for a "follow up on intent &lt;id&gt;" handoff instead of creating a new one |
| `get_intents_for_file` | Check for team conflicts on a file; pass `startLine`/`endLine` to narrow to a line range |
| `assign_blocks_to_intent` | Associate code changes with intent |
| `complete_intent` | Mark intent as committed/done/abandoned |
| `update_intent` | Reformulate an intent's title, description, scope, or constraints as understanding evolves |
| `list_team_intents` | See what teammates are working on |

#### Decision Recording

| Tool | Purpose |
|------|---------|
| `record_decision` | Record an architectural decision with rationale |
| `get_session_decisions` | Get decisions recorded during current session (summary-only; expand via `get_decision_detail`) |
| `get_project_decisions` | Get all decisions across all intents for the project (summary-only; expand via `get_decision_detail`) |
| `get_decision_detail` | Expand one decision to full rationale/context/consequences/alternatives |
| `edit_session_decision` | Edit or delete a decision before intent completion |
| `detect_intent_conflicts` | Detect if current intent decisions conflict with team decisions |

#### History Inference

| Tool | Purpose |
|------|---------|
| `infer_history` | One-time-ish: mine git history into intents and decisions. Estimate first, then run. Decision curation runs automatically as its final phase |

#### Lightweight Logging

| Tool | Purpose |
|------|---------|
| `log_work` | Log completed work without the full intent lifecycle (quick fixes, trivial changes) |

#### Conflict Resolution (Layer C)

| Tool | Purpose |
|------|---------|
| `get_resolution_context` | When a live peer is editing the same lines, fetch their decrypted code at the overlap + recorded reasoning + a resolution guardrail, so you can adapt before writing |
| `arbiter_resolve` | Get Kawa's AI verdict for live overlaps — suggest-only, never writes. Per overlap: compatible / auto_resolvable / conflict + confidence + perf/security risk + tier (0 no-op · 1 auto-appliable · 2 draft-and-confirm · 3 conflict) |
| `arbiter_apply` | Judge → adversarially verify → AUTO-APPLY only the trivial tier (high-confidence single-range merge), and ONLY in an agent-owned worktree (writes + records a decision + republishes). Human checkout / locked → suggest-only. Re-read any applied file |

> **Detect → resolve protocol (once per turn, advisory).** A live collision surfaces in the **Stop** hook's collision report at turn end — one or more peers (teammates or AI agents) whose in-progress edits overlap the lines you touched this turn, each with a `uid` and overlapping file `ranges`. (Detection lives only here: it was relocated off the per-edit path to the Stop hook, and the per-edit pre-edit check has since been retired entirely.) When you see one, call `get_resolution_context(peerUid, filePath, ranges)` with the collision's `uid` and overlapping `ranges`. It returns the peer's actual code at those lines (`peerSnippet`), the file's recorded decisions, and a `guardrail`: never overwrite a peer's **committed** work; your resolution is an ordinary git edit (revert is the undo); record_decision(type=fork|tradeoff, …) explaining how you resolved before completing; and choose ONE coherent result — never blindly interleave both diffs. The report is advisory by default (injected as context; you decide whether to coordinate, rework, or surface it to the user); a per-repo setting can switch it to block-to-continue. Opt out with `KAWA_STOP_COLLISION_CHECK=off`.

> **Completion-time gate (blocking).** If a same-line overlap with a live peer still exists when you finalize, `complete_intent` returns `{ success: false, reason: "resolution_required", collisions, guardrail }` and the intent stays active (it is NOT completed). To proceed: for each collision, call `get_resolution_context(peerUid, filePath, ranges)` to see the peer's code, resolve it in your own working tree (yield/synthesize, or override with rationale), then call `record_decision(type=fork|tradeoff, …, resolvedCollision={ peerUid, filePath, ranges, peerLabel?, peerIntentId?, baselineSha? })` for each one, and re-run `complete_intent`. A genuine yield removes the overlap; an override is cleared by the recorded `resolvedCollision`. Do not loop `complete_intent` without resolving — it will keep returning `resolution_required`.

> **AI resolution (arbiter).** Beyond reading a peer's code, Kawa can *judge* and, for the safe tier, *apply* a resolution. Pass the Stop report's collisions as `overlaps: [{ peerUid, filePath, ranges }]` to `arbiter_resolve` to get a per-overlap verdict (compatible / auto_resolvable / conflict + confidence + risk + **tier**): tier 0 = no change needed; tier 1 = trivially auto-appliable; tier 2 = a draft merge to confirm; tier 3 = a real conflict. To act, call `arbiter_apply` — it adversarially verifies and writes the **tier-1** merge to your worktree (recording a decision + republishing), but **only in an agent-owned worktree**; on a human checkout or a peer-held lock it stays suggest-only. After `arbiter_apply`, **re-read any file it applied to** (it changed on disk). For tier-2/3 (surfaced, not applied) overlaps, call `get_resolution_context` to see the peer's code and resolve manually per the guardrail above. The Kawa server never sees your code — all decryption and judgment run locally.

### Repository Origin

Replace with your repository's origin:
- `git@github.com:yourorg/yourrepo.git`
```

---

## Intent Types

When creating intents, use appropriate template types:

| Type | Use For |
|------|---------|
| `feature` | New functionality, user-facing changes |
| `refactor` | Code restructuring without behavior change |
| `exploration` | Research, prototyping, investigation |

---

## History Inference

Two MCP tools analyze git commit history to extract structured development knowledge — useful for bootstrapping a repository with historical context.

### `infer_history`

Analyzes a repository's git commit history and produces intents and decisions for the repo. Runs asynchronously inside Kawa Code with progress shown in the desktop app; if interrupted, re-running resumes from where it left off.

**Usage:**
```
Use the infer_history tool with estimateOnly: true to preview the cost first,
then run it with estimateOnly: false.
```

### Feature catalog

There is no MCP tool for this. Rebuild the catalog from the **Features** panel in the Kawa Code app — **Update features** (additive) or **Rebuild** (cold, keeps locked features). It also extends automatically after an `infer_history` run.

---

## Multi-Repo Projects

For monorepos or multi-project setups, each sub-project with its own git origin needs separate intent tracking. List all origins in your CLAUDE.md:

```markdown
### Repository Origins

- `git@github.com:yourorg/frontend.git`
- `git@github.com:yourorg/backend.git`
- `git@github.com:yourorg/shared-libs.git`
```

---

## Edge Cases

### Stale Intents

If an intent has been active for a long time (>24 hours), proactively ask:
> "You have an active intent '[title]' from [time ago]. Want to continue, commit, or abandon it?"

### Non-Git Directories

The intent workflow only applies to git repositories. For non-git directories:
- Skip intent tracking
- Use standard file operations
- No commit flow needed

### Team Conflicts

Before modifying files, check `get_intents_for_file`. If a teammate has an active intent on the same file:
- Warn the user about potential conflicts
- Suggest coordinating with the teammate
- Proceed if user confirms

---

## Customization

### Adjusting Context Switch Sensitivity

The default is conservative (only prompt on clear divergence). To be more aggressive:
- Add explicit scope keywords to intent descriptions
- Use more specific intent titles

### Skipping Intent Tracking

For trivial changes, users can say:
- "Quick fix, no intent needed"
- "Skip intent tracking for this"

The AI should respect these and proceed without the workflow.

### Custom Commit Message Format

Adapt the commit message template to your project's conventions:

```markdown
### Commit Message Format

Use this format for commits:
[type]: <title>

<body>

Intent-ID: <id>
```

---

## Troubleshooting

### MCP Connection Issues

If tools fail with connection errors:
1. Ensure Kawa Code is running
2. Check socket path: `~/.kawa-code/sockets/muninn`
3. Restart Kawa Code if needed

### Intent Not Found

If `check_active_intent` returns nothing but you expected one:
- Intents are per-repository; check you're using the correct origin
- Intents may have been completed or abandoned in a previous session

### Git Operations Fail

If commits fail:
- Check for merge conflicts
- Ensure you have write access to the repo
- Verify the working directory is clean enough to commit

---

## Quick Start Checklist

- [ ] Install kawa-intents MCP server
- [ ] Start Kawa Code desktop app
- [ ] Create CLAUDE.md with workflow instructions
- [ ] Add repository origin to CLAUDE.md
- [ ] Test with `check_active_intent` call

Once set up, the workflow runs automatically — the AI will track intents, record decisions, and prompt for commits when you switch tasks.
