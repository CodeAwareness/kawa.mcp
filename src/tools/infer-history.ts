import { z } from 'zod'
import { request } from '../services/muninn-ipc.js'

export const inferHistorySchema = z.object({
  repoPath: z.string().describe('Local path to the repository root'),
  commits: z.number().optional().describe('Number of recent commits to analyze. If omitted, the server resumes from the last commit infer_history processed for this repo (or falls back to 50 on first run). Mutually exclusive with `commitRange`.'),
  commitRange: z.string().optional().describe('Optional git revspec to process a specific commit range instead of the N most recent (e.g. "sha1..sha2", "branch1..branch2", "sha1^!" for a single commit). Useful for recovering from dropped batches or targeted backfills. Mutually exclusive with `commits`.'),
  contextIssues: z.boolean().optional().default(false).describe('Include context issues from commit date range (requires gh/glab CLI)'),
  model: z.string().optional().default('claude-sonnet-4-20250514').describe('Model slug used for the token/cost estimate only. It does NOT select the model the run uses — that is configured in the Kawa Code app.'),
  maxStories: z.number().optional().default(0).describe('Maximum number of stories to analyze in this run (0 = unlimited).'),
  allowCommitSplitting: z.boolean().optional().default(false).describe('Allow splitting a single commit into multiple stories when it contains unrelated changes (recommended for repos with messy commit history)'),
  estimateOnly: z.boolean().optional().default(true).describe('If true (default), only estimate token cost without running the pipeline. Set to false to run the full pipeline.'),
  force: z.boolean().optional().default(false).describe('Override the re-run guard. When the repo already has intents and infer_history cannot cleanly resume (missing/unreachable cursor), or when HEAD is not on the default branch, the run is stopped and a confirmation is requested. Set `force: true` to proceed anyway, accepting the duplicate-intent risk. Exact-commit duplicates are still skipped automatically; overlapping re-groupings are not. A forced run on a non-default branch additionally does NOT advance the resume cursor. Does not override a hard failure such as the desktop app being unreachable.'),
})

export type InferHistoryInput = z.infer<typeof inferHistorySchema>

export type AutoMode =
  | 'first-run'
  | 'resume'
  | 'head-equals-last'
  | 'fallback-rewritten'
  | 'fallback-no-remote'
  | 'fallback-error'

export interface AutoModeResolution {
  commits: number
  mode: AutoMode
  lastSha?: string
}

/** Surfaced by the re-run guard when a run is stopped pending user confirmation. */
export interface GuardDecision {
  reason: 'populated_repo_no_clean_resume' | 'non_default_branch'
  intentCount: number
  lastSha?: string
  head: string
  isDefaultBranch: boolean
}

export interface InferHistoryResponse {
  started?: boolean
  /** Set when the re-run guard stopped the run; caller should confirm and re-call with force. */
  needsDecision?: GuardDecision
  estimate?: {
    pass1_input: number
    pass1_output: number
    pass2_input: number
    pass2_output: number
    total_input: number
    total_output: number
    est_stories: number
    cost_usd: number
  }
  forge?: string
  forge_cli_available?: boolean
  commit_count?: number
  autoMode?: AutoModeResolution
  message: string
}

function describeAutoMode(am: AutoModeResolution): string {
  const sha = am.lastSha ? ` (last_inferred_sha=${am.lastSha.slice(0, 7)})` : ''
  switch (am.mode) {
    case 'first-run':
      return `\nℹ Auto-mode: first run for this repo — analyzing fallback of ${am.commits} most recent commits.`
    case 'resume':
      return `\nℹ Auto-mode: resumed${sha} — ${am.commits} commits since last run.`
    case 'head-equals-last':
      return `\nℹ Auto-mode: HEAD already matches last_inferred_sha${sha} — nothing new to analyze.`
    case 'fallback-rewritten':
      return `\n⚠ Auto-mode: stored last_inferred_sha${sha} is no longer reachable (rebase/GC/branch switch). Falling back to ${am.commits} most recent commits.`
    case 'fallback-no-remote':
      return `\n⚠ Auto-mode: no git remote 'origin' — cannot key resume state. Falling back to ${am.commits} most recent commits.`
    case 'fallback-error':
      return `\n⚠ Auto-mode: failed to resolve resume state (see Muninn logs). Falling back to ${am.commits} most recent commits.`
  }
}

/** Build the agent-facing message when the re-run guard stops a run. */
function describeGuardDecision(d: GuardDecision): string {
  const head = d.head ? d.head.slice(0, 7) : '?'
  if (d.reason === 'non_default_branch') {
    return `infer_history stopped: HEAD (${head}) is not on the repository's default branch. ` +
      `Inferring a feature branch risks creating intents that duplicate work once it is squash/rebase-merged into the default branch. ` +
      `Recommended: switch to the default branch (main/master) and re-run. ` +
      `To proceed here anyway, re-call infer_history with force: true — a forced non-default run will NOT advance the resume cursor.`
  }
  // populated_repo_no_clean_resume
  return `infer_history stopped: this repo already has ${d.intentCount} intent(s), but the run cannot cleanly resume ` +
    `(${d.lastSha ? `stored cursor ${d.lastSha.slice(0, 7)} is no longer reachable — rebase/GC/branch switch` : 'no resume cursor is recorded'}). ` +
    `Re-running could create duplicate intents for history that is already covered. ` +
    `To proceed anyway, re-call infer_history with force: true. ` +
    `Exact-commit duplicates are skipped automatically; overlapping re-groupings are not.`
}

export async function inferHistory(input: InferHistoryInput): Promise<InferHistoryResponse> {
  // commits and commitRange are mutually exclusive. Catch in the MCP layer so
  // the user gets a clear error instead of an opaque muninn-side rejection.
  if (input.commits !== undefined && input.commitRange !== undefined) {
    throw new Error('infer_history: `commits` and `commitRange` are mutually exclusive — set only one.')
  }

  // Only forward `commits` when the caller explicitly provided one, so the
  // server can fall back to last_inferred_sha tracking otherwise.
  const inferencePayload: Record<string, any> = {
    repoPath: input.repoPath,
    contextIssues: input.contextIssues,
    model: input.model,
    force: input.force,
  }
  if (input.commits !== undefined) inferencePayload.commits = input.commits
  if (input.commitRange !== undefined) inferencePayload.commitRange = input.commitRange

  if (input.estimateOnly) {
    // Walking git history on deep repos (e.g., zed at 37k commits) exceeds
    // the 30s default. Estimate is synchronous — no async-start response —
    // so the caller blocks until the server returns.
    const ESTIMATE_TIMEOUT_MS = 180_000
    const res = await request('inference', 'estimate', inferencePayload, ESTIMATE_TIMEOUT_MS)

    if (res.status === 'needs_decision') {
      return { needsDecision: res.decision, message: describeGuardDecision(res.decision) }
    }

    let forgeWarning = ''
    if (!res.forge_cli_available) {
      const forge = res.forge ?? 'Unknown'
      if (forge === 'Unknown') {
        forgeWarning = '\n⚠ Unrecognized git hosting platform. PR/MR descriptions and issue discussions will be skipped.'
      } else if (forge === 'GitHub') {
        forgeWarning = '\n⚠ GitHub CLI (gh) not found or not authenticated. PR descriptions and issue discussions will be skipped. Run `gh auth login` to include them.'
      } else if (forge === 'GitLab') {
        forgeWarning = '\n⚠ GitLab CLI (glab) not found or not authenticated. MR descriptions and issue discussions will be skipped. Run `glab auth login` to include them.'
      }
    }

    const autoModeNote = res.autoMode ? describeAutoMode(res.autoMode) : ''

    return {
      estimate: res.estimate,
      forge: res.forge,
      forge_cli_available: res.forge_cli_available,
      commit_count: res.commit_count,
      autoMode: res.autoMode,
      message: `Estimated cost: $${res.estimate?.cost_usd ?? '?'} for ~${res.estimate?.est_stories ?? '?'} stories from ${res.commit_count ?? '?'} commits${autoModeNote}${forgeWarning}`
    }
  }

  const runPayload: Record<string, any> = {
    repoPath: input.repoPath,
    contextIssues: input.contextIssues,
    model: input.model,
    maxStories: input.maxStories,
    allowCommitSplitting: input.allowCommitSplitting,
    force: input.force,
  }
  if (input.commits !== undefined) runPayload.commits = input.commits
  if (input.commitRange !== undefined) runPayload.commitRange = input.commitRange

  const res = await request('inference', 'run', runPayload)

  if (res.status === 'needs_decision') {
    return { needsDecision: res.decision, message: describeGuardDecision(res.decision) }
  }

  const autoModeNote = res.autoMode ? describeAutoMode(res.autoMode) : ''

  return {
    started: res.started,
    autoMode: res.autoMode,
    message: (res.message || 'Inference pipeline started. Progress updates will be sent as the pipeline runs.') + autoModeNote
  }
}

export const inferHistoryTool = {
  name: 'infer_history',
  description: `Analyze a repository's git commit history and produce structured development knowledge (intents and decisions) for the repo.

When to use:
- To bootstrap a repository that has no recorded intents/decisions yet.
- To extend coverage for new commits since the last run (resumes automatically when no \`commits\` value is provided).

Inputs of note:
- \`estimateOnly\` (default true): returns a token/cost estimate without running. Call with \`estimateOnly: true\` first to preview cost, then re-call with \`estimateOnly: false\` to run.
- \`commits\` (optional): how many recent commits to analyze. Omit to resume from where the last run stopped (or fall back to a sensible default on first run).
- \`commitRange\` (optional): git revspec selecting a specific window — \`"sha1..sha2"\`, \`"branch1..branch2"\`, \`"sha1^!"\` for a single commit. Mutually exclusive with \`commits\`. Useful for recovering from dropped batches or backfilling specific PRs / branches without re-running the full history.
- \`contextIssues\`: include PR/MR descriptions and issue discussions when an authenticated forge CLI (\`gh\` or \`glab\`) is available; auto-skipped otherwise.
- \`allowCommitSplitting\`: enable when commit history is messy and a single commit may cover unrelated changes.
- \`maxStories\`: per-run cap on how many stories are analyzed.
- \`model\`: affects the cost estimate only — it does not choose the model the run uses. The run's model is configured in the Kawa Code app.
- \`force\` (default false): override the re-run guard (see Behavior).

Behavior:
- A run is asynchronous — returns immediately with a started/pending status; progress is reported separately.
- Results are persisted as intents and decisions for the repo on completion.
- If interrupted, re-running resumes from where it left off.
- Re-run guard: a clean incremental resume runs automatically. But if the repo already has intents and the run cannot cleanly resume (missing/unreachable cursor), or HEAD is not on the default branch, the call STOPS and returns \`needsDecision\` instead of running — re-running blind there risks duplicate intents. Present the reason to the user and, if they confirm, re-call with \`force: true\`. Run on the default branch (main/master) whenever possible; inferring a feature branch is what \`force\` is for.
- GitHub and GitLab are supported; the forge is detected from the remote origin.`,
  inputSchema: inferHistorySchema,
  handler: inferHistory
}
