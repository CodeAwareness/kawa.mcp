export const intentFirstWorkflowPrompt = {
  name: 'implementation_workflow',
  description: 'Standard workflow for implementing code changes with intent tracking. Use this when starting any code implementation task.',
  arguments: [
    {
      name: 'task_description',
      description: 'Brief description of what the user wants to implement',
      required: false
    }
  ],
  getPrompt: (args?: { task_description?: string }) => {
    const taskContext = args?.task_description
      ? `\n\n**Current Task**: ${args.task_description}`
      : ''

    return `## AI Code Implementation Workflow${taskContext}

When implementing code changes, follow the intent-aware workflow below. This workflow tracks your work, enables team visibility, and streamlines the commit process.

### Task Complexity Triage

Before using MCP tools, assess the task complexity. Match your workflow to the task — don't pay 2K tokens of overhead for a one-line fix.

**Skip MCP entirely** — Single-file fixes, typos, adding a log line, renaming a variable, anything where the change is obvious from the prompt alone. Just write the code.

**Lightweight** — Bug fixes, small features in 1-2 files, work in familiar code areas. Use only:

| When | Action | Tool |
|------|--------|------|
| **Before coding** | Check for active intent (resume if exists) | \`check_active_intent\` |
| **After edits** | Log what was done | \`log_work\` |

**Full workflow** — Multi-file features, unfamiliar code areas, architectural decisions, cross-cutting changes, or work that may overlap with teammates. Use the complete lifecycle:

| When | Action | Tool |
|------|--------|------|
| **After exploring request** | Get relevant context (with discovered files) | \`get_relevant_context\` |
| **Before coding** | Check/create intent | \`check_active_intent\`, \`create_and_activate_intent\` |
| **On "done"/"commit"/"worked"/etc.** | Verify diff → Git commit → Complete | \`git status\`, \`complete_intent\` |

> **Note**: Code blocks are attached to the intent automatically when you call \`complete_intent\` with a commit SHA. There is no manual "assign blocks" step.

**Trigger phrases for commit flow**: "this worked", "let's commit", "done", "close this", "ship it", "looks good"

**Token-efficient context**: Call \`get_relevant_context\` **after initial exploration** of the user's request — once you know which files are involved. Pass both the prompt AND the \`activeFiles\` parameter with files you've discovered. This gives much better relevance matching than calling with just a vague prompt.

### During Implementation

- Write code as normal
- Track which files and line ranges you modify (you'll need this for block assignment)
- If you discover the scope is larger than expected, continue under the same intent
- **Record decisions silently** as they occur (see "Recording Decisions" below)

### Recording Decisions

Record decisions silently using \`record_decision\` when you:

| Trigger | Decision Type | Example |
|---------|---------------|---------|
| Choose between alternatives | \`fork\` | "Selected Rust over TypeScript for performance" |
| Try an approach that fails | \`abandoned\` | "mongodb-memory-server rejected due to binary issues" |
| Find unexpected limitation | \`discovery\` | "Unix socket paths limited to 104 chars on macOS" |
| Identify hard requirement | \`constraint\` | "Must work offline per project requirements" |
| Make explicit trade-off | \`tradeoff\` | "Chose simplicity over flexibility" |
| Select library/dependency | \`dependency\` | "Using serde for JSON serialization" |
| **Option violates constraint** | Include in \`constraintViolations\` | Document in \`record_decision\` |

**Important**:
- Record decisions silently - do not announce to the user that you're recording
- Decisions made during **conversation** (planning, discussion) are just as important as implementation decisions
- If you forget to record during work, catch them in the pre-commit review (see Commit Flow)
- Decisions are reviewed before commit

### Commit Prompt

When you detect a context switch, prompt the user:

> "You have uncommitted work on **'[intent title]'** ([N] files changed). This new request appears to be a different task. Would you like to:
> 1. **Commit** the current work first, then start on the new task
> 2. **Continue** - this is actually related to the current intent
> 3. **Abandon** the current work without committing"

Use \`git status\` to get the file count and change summary for the prompt.

### Commit Flow

When the user chooses to commit (or explicitly requests it):

1. **Get changes**: Call \`git status\` to see modified files

2. **Review conversation for missed decisions**: Analyze the conversation since the intent was created. Look for architectural decisions that were made but not yet recorded:
   - **Alternatives discussed**: "Should we use X or Y?" → "Let's use X because..."
   - **Rejected approaches**: "We can't do X because..." or "This won't work due to..."
   - **Trade-offs made**: "The trade-off is..." or "We chose simplicity over performance"
   - **Constraints discovered**: "We have to..." or "This is limited by..."
   - **Dependencies selected**: "Let's use [library] for [purpose]"
   - **Approach changes**: "Initially tried X, but switched to Y because..."

   If you identify any architectural decisions that weren't recorded, call \`record_decision\` now.

3. **Get decisions**: Call \`get_session_decisions\` to retrieve all decisions (including any just recorded)

4. **Present review** (if decisions were recorded):
   \`\`\`
   Ready to commit "[intent title]" (N files changed)

   Decision points recorded this session:
   1. [fork] Chose approach A over B
      └─ Rejected: "approach B" (violates zero-knowledge)
   2. [discovery] Found socket path length limit

   Include these in the intent record? [Yes] [Edit] [Skip]
   \`\`\`
5. **Git operations**:
   \`\`\`bash
   git add <files>
   git commit -m "<intent title>

   <intent description if meaningful>

   Key decisions:
   - <decision 1 summary>
   - <decision 2 summary>

   Intent-ID: <intent-id>
   Co-Authored-By: Claude <noreply@anthropic.com>"
   \`\`\`
6. **Complete intent**: Call \`complete_intent\` with the commit SHA and status='committed'. The modified code blocks are auto-captured and attached to the intent as part of the same call.
7. **Report**: Tell the user the commit SHA and that the intent is complete

- If user had a new request that triggered the commit, proceed to create a new intent for it
- If user explicitly said "we're done", the workflow ends

| Scenario | Handling |
|----------|----------|
| User returns after long break with stale intent | Proactively mention: "You have an active intent '[title]' from [time ago]. Want to continue, commit, or abandon it?" |
| Pre-existing uncommitted changes when creating intent | Note in \`git status\` warnings; let user decide what to include |
| Git commit fails | Report error, keep intent active, let user resolve |
| User makes changes outside Claude | \`git status\` shows all uncommitted changes; user decides what to commit |
| Multiple small tasks in quick succession | Use judgment - if truly separate, prompt; if related, batch under one intent |

### Retroactive Intent Assignment (Committing Pre-Existing Changes)

When uncommitted changes exist that weren't made under an active intent (e.g., changes from a previous session, manual edits, or mixed work), use this workflow to infer intents and commit them in logical groups:

#### Step 1: Analyze Changes
- Run \`git diff --stat\` and read individual diffs to understand what each change does

#### Step 2: Group by Intent
- Identify logical groupings — changes that serve the same purpose belong together
- Common grouping signals: same feature area, same service/module, related refactoring, shared motivation

#### Step 3: Match to Existing Intents
For each group:
1. Call \`list_team_intents\` to get active intents for the repo
2. Look for an existing intent whose title and description accurately describe the group's changes
3. If a match exists, use it. If not, create a new intent or use \`log_work\` for trivial changes

#### Step 4: Commit Each Group
For each group:
1. \`git add\` only the files belonging to this group
2. \`git commit\` with a message reflecting the intent
3. Call \`complete_intent\` with the commit SHA (if using an existing intent) or \`log_work\` (for trivial changes)

#### Guidelines
- **Prefer existing intents** when they accurately describe the changes — avoid creating duplicates
- **Use \`log_work\`** for small standalone changes (doc updates, loading spinners, one-line fixes)
- **Present the grouping plan** to the user before committing, so they can adjust
- **Don't force-fit** — if changes don't match any existing intent, create a new one
- **One intent per commit** — each commit should correspond to exactly one intent

### MCP Tools Reference

#### Context Tools

| Tool | When to Use |
|------|-------------|
| \`get_relevant_context\` | **EACH USER REQUEST** - Returns context relevant to the specific prompt via semantic search (token-efficient for large projects) |

#### Intent Tools

| Tool | When to Use |
|------|-------------|
| \`check_active_intent\` | Before starting any code task |
| \`create_and_activate_intent\` | When no active intent and user requests code changes |
| \`get_intents_for_file\` | Before modifying files (check for team conflicts); add \`startLine\`/\`endLine\` for a specific range |
| \`complete_intent\` | After successful git commit, or to abandon |
| \`list_team_intents\` | To see what teammates are working on |

#### Decision Recording Tools

| Tool | When to Use |
|------|-------------|
| \`record_decision\` | When making architectural decisions (silently, during work). Omit intentId for repo-scoped decisions (discoveries, constraints) |
| \`get_session_decisions\` | Before commit, to review recorded decisions |
| \`get_project_decisions\` | To see all decisions across all intents for the project |
| \`edit_session_decision\` | To modify or delete a decision before commit |
| \`detect_intent_conflicts\` | Before commit, to check for conflicts with team decisions |`
  }
}

export const prompts = [intentFirstWorkflowPrompt]
