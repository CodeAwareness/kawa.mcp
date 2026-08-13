# Kawa Code MCP

> Team-aware memory for AI coding assistants. Track intent, record decisions, and see when a teammate is editing the same code — in real time, before commit.

`@kawacode/mcp` is the official [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [Kawa Code](https://kawacode.ai). It lets Claude Code, Cursor, and any MCP-compatible AI assistant:

- **Remember what you're working on** across sessions, branches, and machines — no more re-explaining the architecture every morning.
- **Surface team conflicts before they happen** — know when a teammate is editing the same file or function in their working copy *right now*, before either of you commits.
- **Capture architectural decisions with their reasoning** — future you (and future AI sessions) inherit the team's accumulated context instead of relitigating choices.
- **Link commits to intent automatically** — every commit gets the *why* attached, not just the diff.

## Prerequisites

### Required

- **Node.js >= 18.0.0** — runtime for the MCP server
- **[Kawa Code](https://kawacode.ai) desktop app running** — kawa.mcp is a thin MCP-to-IPC adapter; all git operations, storage, and API communication happen in Kawa Code

### Optional (for history inference)

- **Anthropic API key** — your own Claude API key, passed as a parameter to the inference tools
- **[GitHub CLI (`gh`)](https://cli.github.com/)** — enables richer data tiers (PR descriptions, review comments, issue discussions). Without `gh`, tiers 2 and 4 are skipped automatically

## Installation

Add the MCP in your AI configuration, for example on Claude Code:

`claude mcp add -s user kawa-intents -- npx -y @kawacode/mcp`

For Cursor AI, install the MCP with `npm install -g @kawacode/mcp` and add it to `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "kawa-intents": {
      "command": "kawacode-mcp"
    }
  }
}
```

Note that the MCP will not be automatically updated to future versions in this scenario.
To upgrade to a newer release, run `npm update -g @kawacode/mcp`.

## Manual Installation

For the project you want Kawa Code to run on, create a `.mcp.json` file in your project root (recommended for teams — commit it to git):

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

## Usage

The MCP server works together with the Kawa Code application, Kawa Code IDE extensions, and AI code generators such as Cursor AI and Claude Code.

## Pre-edit decision check (Claude Code hook)

Optional. When the agent is about to edit code that has prior recorded reasoning attached (an overlapping intent's blocks, or a constraint with the file in `relatedFiles`), the hook surfaces it before the Edit fires. Recommendation maps to action: silent (proceed), advisory context injected (review), or blocked with stderr message (`investigate-upstream`).

Wire it as a Claude Code `PreToolUse` hook in your `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "npx -y -p @kawacode/mcp kawacode-on-pre-edit" }
        ]
      }
    ]
  }
}
```

Override paths when blocked:

- **Persistent (recommended):** record a fork decision that supersedes the existing one and retry the Edit.
  ```
  record_decision(type: "fork", supersedes: ["<surfaced-decision-id>"], rationale: "...")
  ```
- **For this session:** call `pre_edit_acknowledge(decisionIds: ["<surfaced-decision-id>"])`, then retry the Edit — that decision won't block again for the rest of the session. The acknowledgment is read back from your session transcript, so it needs no session token and is unaffected by daemon or session restarts within the same conversation.
- **One-off:** add `force: true` to the Edit tool args to proceed a single time.

Disable the hook for a session with `KAWA_PRE_EDIT_CHECK=off`.

### Local telemetry (logs)

Every pre-edit check fire (and force-override) appends a JSON line to a daily-rotated file at `~/.kawa-code/logs/pre-edit-decision-check-YYYY-MM-DD.jsonl`. Logs are **local only** — nothing leaves your machine. The defaults keep the last 30 days, capped at 100 MB total (oldest files dropped first).

Each line records what fired, why, and what was filtered out — useful for tuning the recommendation thresholds and spotting false positives over time.

Disable telemetry with `KAWA_PRE_EDIT_TELEMETRY=off`.

## Key Features

- **Real-time team conflict detection** — see when a teammate is editing the same files or lines in their working copy, *before either of you commits*. Most version-control tooling shows you this after the merge conflict; Kawa shows you before. Kawa can also *judge* an overlap and apply the safe tier of merge for you — though that write only happens [in an agent-owned worktree](#auto-resolution-requires-a-worktree).
- **Cross-session AI memory** — your AI assistant picks up where it left off across days, branches, and machines. No re-explaining the architecture every morning.
- **Decision history with reasoning** — record forks, trade-offs, and abandoned approaches with their *why*. Future sessions and teammates inherit the context instead of re-deriving it.
- **Commit ↔ intent linkage** — every commit is automatically associated with the intent that drove it. `git log` shows what changed; Kawa shows why.
- **Smart context retrieval** — relevance-based loading; only what the current task needs.
- **Zero-knowledge encryption** — code blocks encrypted client-side before sync. The Kawa cloud cannot decrypt your team's code.
- **Cross-platform** — works with Claude Code, Cursor, and any MCP-compatible AI assistant.

## Running several agents in parallel

Kawa Code is built for more than one worker on a repository at a time — that's what the conflict detection is *for*. If those workers are AI agents you're running yourself, give each one its own [git worktree](https://git-scm.com/docs/git-worktree). Agents sharing a single checkout overwrite each other's edits with no conflict marker and no git history: nothing is committed between the two writes, so nothing notices.

### Set up worktrees

In Claude Code, background sessions already require a worktree — `worktree.bgIsolation` defaults to `"worktree"`, which blocks edits to the main checkout until the session enters one. You only need to touch it if a project has explicitly opted out with `"none"`. Subagents take `isolation: "worktree"` per spawn.

Two settings are worth tuning, because the defaults surprise people:

```json
{
  "worktree": {
    "baseRef": "head",
    "symlinkDirectories": ["node_modules", "target"]
  }
}
```

- **`baseRef`** — defaults to `"fresh"`, which branches from `origin/<default-branch>`. If you work on unpushed commits, set `"head"` to branch from your local HEAD instead. Either way this is a *commit* boundary: uncommitted working-tree changes don't travel into a new worktree, so land your work before spawning agents that need it.
- **`symlinkDirectories`** — nothing is symlinked unless you say so, so every worktree gets its own copy of whatever you leave out. Symlink *dependency* directories freely: `node_modules` is the same content for every worktree, and sharing it costs nothing. **Do not symlink compiled-language build output** — `target/`, `build/`, `obj/`. Those tools name artifacts deterministically from the crate/module and its inputs, *without* encoding which checkout they came from, so two worktrees building into one directory write the same filenames and silently overwrite each other. The symptom is the dangerous part: your suite goes **green while running another checkout's binaries**. Only a test that resolves a path baked in at compile time (Rust's `env!("CARGO_MANIFEST_DIR")`, `include_str!`, or an equivalent) will notice; everything else passes. If a suite ever looks suspiciously green after another checkout built in the same place, clean the build directory and re-run before believing it.

Because compiled build directories can't be shared, they multiply — one per worktree, each growing independently, and they get large enough to matter (a mature Rust `target/` reaches hundreds of gigabytes). Two things keep that affordable, and they solve different halves:

- **Speed** — a compiler cache such as [`sccache`](https://github.com/mozilla/sccache) is safe across worktrees precisely because it caches *results* keyed by input hash rather than sharing an output directory.
- **Disk** — prune periodically. For Rust, [`cargo-sweep`](https://github.com/holmgr/cargo-sweep) removes stale artifacts by age or to a size cap; wire it into whatever cadence fits your setup — after merging a worktree back is a natural trigger. One caveat worth knowing before you rely on it: sweeping only reclaims artifacts the build tool still tracks. If that index has been lost, the leftovers are orphaned and a sweep reports nothing to do no matter the flags — a full clean is the only thing that reclaims them.

### Keeping agents from colliding

Isolation alone would just give you several agents doing overlapping work in private. Kawa's job is the coordination on top.

Each agent session gets its own identity, and intents are tracked **per session** — so several intents can be active on one repository at once, each with its own current focus, without a lock and without agents clobbering each other's context. From there the normal machinery applies across agents exactly as it does across teammates: `get_relevant_context` surfaces what the *other* agents have already decided, `create_and_activate_intent` reports a conflict when new work overlaps something already in flight, and the pre-edit check fires on reasoning any of them recorded.

The practical result: your agents inherit each other's decisions instead of re-deriving them, and you find out about overlapping work while it's still cheap to redirect — not at merge time.

### Auto-resolution requires a worktree

Kawa can do more than *report* an overlap — `arbiter_resolve` judges each one, and `arbiter_apply` will write the safe tier of merge for you. That write is deliberately gated:

> `arbiter_apply` writes **only in an agent-owned worktree**. On a human checkout — or when a peer holds the file-set lock — it stays suggest-only.

This is the sharpest practical reason to put agents in worktrees. Run them on a shared checkout and auto-resolution silently never engages; you get the conflict surfaced and nothing else, with no error to tell you a capability was switched off. The guardrail is intentional — Kawa won't rewrite a human's working tree underneath them — but it does mean the setup decides whether half the feature is available.

## Handing off work to a teammate (no session export)

Because the reasoning behind your work — your intents and recorded decisions — lives in Kawa Code rather than in the chat log, a teammate can pick up where you left off from a single prompt. No transcript sharing, no session restore.

1. **Commit or push your code first.** A handoff prompt carries your *reasoning*, not your uncommitted working tree — so land the code (or publish the pre-commit diff) before you hand off, otherwise your teammate inherits the decisions without the diff that goes with them.
2. **Grab the intent id.** The id of the intent you were working under — your agent can read it back with `check_active_intent`, or you can find it in the Kawa Code app.
3. **Hand over a one-line prompt,** e.g. `Follow up on intent <intent-id>: <what's left to do>`.
4. **Your teammate pastes it into a fresh session.** Their agent calls `resume_intent(<id>)` — one call that adopts the intent as their current focus *and* loads its recorded decisions — resuming the thread with full context, even though it never saw your chat.

**What transfers:** the intent, its decisions, and (once committed) its code. **What doesn't:** your chat transcript and any session-local state. An acknowledgment you made to a pre-edit block is *your* judgment in *your* session, so your teammate re-evaluates it rather than inheriting it — which is what you want.

**Teams:** to make the handoff seamless, add one line to your shared `CLAUDE.md` so the agent always treats a follow-up prompt as *resuming* the named intent instead of opening a new one:

> When a prompt says "follow up on intent `<id>`" (or similar), call `resume_intent(<id>)` to adopt that intent and load its decisions — do not create a new intent for it.

## Migrating or rewriting a codebase? Transplant its decisions

When you port a codebase to a new language or rebuild it in a fresh repository, the code moves — but the *reasoning* usually doesn't. The source repo's decision history knows why retired approaches were retired, which constraints are load-bearing, and where the security landmines are. With Kawa Code, that history becomes a first-class migration input.

Decisions are scoped per repository, so the new repo won't surface the old repo's history automatically. Transplant them slice by slice as you port — this is the **recall-transplant workflow**:

1. **Recall before porting each slice.** Call `get_relevant_context` against the *source* repo with a description of the subsystem you're about to port (name its key files). This surfaces the forks, constraints, trade-offs, and discoveries that shaped it.
2. **Expand what matters.** Recall returns summaries — call `get_decision_detail` on the load-bearing hits for the full rationale and consequences.
3. **Classify: stack-portable vs stack-bound.** Domain truths port: protocol contracts, cost/scale rationale, security discoveries, "we tried X and retired it" warnings. Mechanics of the old stack don't: build-tooling quirks, runtime workarounds, library-specific fixes. Only the portable ones move.
4. **Re-record the portable ones in the *target* repo** with `record_decision`, citing provenance in the summary or rationale (e.g. `[transplanted from <source-repo> <decision-id>]`). Merge decisions that form one lineage into a single record.
5. **Let the transplants shape the port and its tests.** A transplanted durability rationale should become a test that proves the property survived the rewrite; a retired-approach warning should stop the new stack from reintroducing it.

The payoff compounds: the port doesn't re-litigate settled arguments or faithfully reproduce old bugs, *negative knowledge* survives even though the code that motivated it was deleted long ago, and at cutover the new repo starts with a curated decision corpus instead of an empty one.

The [CLAUDE.md template](./CLAUDE.md.example) ships a compact version of this workflow, so agents set up through the Kawa Code welcome flow follow it automatically.

## Occasional operations

Most Kawa tools run every turn — check the active intent, recall context, record a decision. The operations below are different: you run them **rarely**, sometimes once per repository. They cost real time and money, and they are not part of the per-turn loop.

### Seeding a repo from its git history — `infer_history`

A brand-new Kawa repo knows nothing about work that predates it. `infer_history` mines the existing commit history into intents and decisions, so recall has something to draw on from day one. Run it **once** when you connect a repo with meaningful history; after that it extends incrementally.

It is agent-invoked — ask your assistant, e.g. *"Run infer_history with max 3000 commits"*. There is no button for it in the Kawa Code app.

**Always estimate first.** The tool defaults to `estimateOnly: true`, which returns a token/cost preview without running anything. Look at the number, then re-run with `estimateOnly: false` to actually start. A run is asynchronous — it returns immediately and reports progress in the Kawa Code app — and resumes from where it stopped if interrupted.

| Parameter | Default | Purpose |
|---|---|---|
| `estimateOnly` | `true` | Preview cost without running. Set `false` to execute. |
| `commits` | resume | How many recent commits to analyze. Omit to continue from the last run. |
| `commitRange` | — | Git revspec (`sha1..sha2`, `branch1..branch2`, `sha1^!`) for a specific window. Mutually exclusive with `commits`. Good for backfilling a PR or recovering a dropped batch. |
| `contextIssues` | `false` | Pull in PR/MR descriptions and issue discussions. Needs an authenticated `gh` or `glab`; silently skipped otherwise. |
| `allowCommitSplitting` | `false` | Enable when one commit often mixes unrelated changes. |
| `maxStories` | — | Per-run cap on stories analyzed. |
| `model` | — | Affects the **estimate only**. The run's model is configured in the Kawa Code app. |
| `force` | `false` | Override the re-run guard — see below. |

**The re-run guard.** If the repo already has intents and the run can't cleanly resume (missing or unreachable cursor), or `HEAD` isn't on the default branch, the call stops and returns `needsDecision` instead of running. That's deliberate: re-running blind duplicates intents. Read the reason, and only pass `force: true` if it genuinely applies. Prefer running on `main`/`master`; `force` exists for the deliberate feature-branch case.

GitHub and GitLab are both supported; the forge is detected from the remote origin.

### Decision evolution — automatic, no call needed

Curating decisions into an evolution graph is **phase 5 of `infer_history`**, run automatically once the analysis completes. There is no separate step and nothing to invoke.

> Earlier versions exposed an `evolve_decisions` tool. It has been removed: it required a `stories` array that only ever existed inside the pipeline's own memory, so no assistant could construct a valid call. Nothing is lost — the curation still runs, as part of `infer_history`.

### Updating the feature catalog — use the Features panel

Features group a repo's intents into a browsable catalog. Rebuild it from the **Features** panel in the Kawa Code app:

- **Update features** — additive. Folds intents that aren't in the catalog yet into the existing features. This is the everyday action.
- **Rebuild** — cold rebuild from scratch, keeping locked features. Use when the catalog has drifted badly.

Progress shows in the app, and the catalog also extends automatically after an `infer_history` run.

> Earlier versions exposed an `update_features` MCP tool that sent the same request as the **Update features** button. It has been removed — one button and one tool doing the identical thing meant every session paid for a tool schema it never needed. Press the button instead.

## Development

```bash
# Watch mode (auto-rebuild on file changes)
npm run dev

# Build TypeScript to JavaScript
npm run build

# Clean build artifacts
npm run clean

# Run the MCP server directly
npm start
```

### Testing the MCP Server

To test the MCP server without integrating it into an AI assistant:

1. Build the project: `npm run build`
2. Run the server: `npm start`
3. The server communicates via stdio (standard input/output)
4. You can send MCP protocol messages via stdin to test tool functionality

### Development Tips

- Use `npm run dev` to auto-rebuild during development
- Check stderr for server logs (stdout is reserved for MCP protocol)
- Ensure Kawa Code is running before testing

## Architecture

```
Claude Code / Cursor AI
    ↓ MCP Protocol (stdio)
kawa.mcp (this server)
    ↓ Huginn IPC (Unix socket / Named pipe)
Kawa Code Desktop App
    └─ HTTP Client
        ↓ REST + SSE
    Kawa API (cloud)
        └─ Team sync & zero-knowledge encryption
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTION.md) and [CLA.md](CLA.md).

## License

This project is source-available under the
Kawa Code Source Available License.

You may run and modify the software for personal or internal use.

See [LICENSE](LICENSE) for details.
