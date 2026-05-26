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

### Commit Flow

When committing:

1. Call `get_intent_changes` to see modified files
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

#### Intent Management

| Tool | Purpose |
|------|---------|
| `check_active_intent` | Check for active intent before starting work |
| `create_and_activate_intent` | Create new intent for a task |
| `get_intents_for_file` | Check for team conflicts on a file |
| `get_intents_for_lines` | Check for conflicts on specific lines |
| `assign_blocks_to_intent` | Associate code changes with intent |
| `get_intent_changes` | Get uncommitted changes summary |
| `complete_intent` | Mark intent as committed/done/abandoned |
| `update_intent` | Reformulate an intent's title, description, scope, or constraints as understanding evolves |
| `list_team_intents` | See what teammates are working on |

#### Decision Recording

| Tool | Purpose |
|------|---------|
| `record_decision` | Record an architectural decision with rationale |
| `get_session_decisions` | Get decisions recorded during current session |
| `get_project_decisions` | Get all decisions across all intents for the project |
| `edit_session_decision` | Edit or delete a decision before intent completion |
| `detect_intent_conflicts` | Detect if current intent decisions conflict with team decisions |

#### History Inference

| Tool | Purpose |
|------|---------|
| `infer_history` | Analyze git commit history to extract development stories and decisions |
| `evolve_decisions` | Re-curate previously extracted stories so only the decisions still worth keeping are persisted |

#### Lightweight Logging

| Tool | Purpose |
|------|---------|
| `log_work` | Log completed work without the full intent lifecycle (quick fixes, trivial changes) |

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

### `evolve_decisions`

Re-curates a pre-existing set of stories (e.g., from a previous `infer_history` run) so that only the decisions still worth keeping are persisted. `infer_history` already performs this curation automatically — use `evolve_decisions` only when you want to run it separately on existing stories.

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
