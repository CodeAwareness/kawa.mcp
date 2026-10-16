import { execSync } from 'child_process'

/**
 * Resolves the git remote origin URL for a repository path, as configured (the
 * raw `remote.origin.url`). Kawa Code canonicalizes it server-side.
 *
 * Uses a local `git config` call instead of IPC to Muninn, avoiding
 * project registration side effects (in-memory state changes, git operations,
 * API calls). Intent storage is keyed by origin string, not by registered
 * project, so intent CRUD works without project activation.
 *
 * @param repoOrigin - User-provided git remote origin (fallback)
 * @param repoPath - Local path to the repository root
 * @returns The git remote origin URL
 */
export function resolveOrigin(repoOrigin: string | undefined, repoPath?: string): string {
  if (repoPath) {
    try {
      const origin = execSync('git config --get remote.origin.url', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      }).trim()
      if (origin) return origin
    } catch {
      // fall through to repoOrigin fallback
    }
  }
  if (repoOrigin) return repoOrigin
  throw new Error(
    'Could not resolve git remote origin. Provide repoPath pointing to the repository root, or pass repoOrigin explicitly. Kawa Code needs a git remote on github.com or gitlab.com; local-only repositories are not supported.'
  )
}
