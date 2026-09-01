import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * What changed, according to git. TB-358.
 *
 * Only ever a list of paths, relative to the Storybook project root, so that
 * affected.ts can stay pure and be tested without a repository. The three
 * failure modes that matter are all reported rather than turned into an empty
 * list: no repository, an unknown base ref, and a git that is not installed.
 * An empty list means "nothing changed", and something that means "I could not
 * tell" must never be allowed to look like it.
 */

export class GitError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'GitError'
  }
}

function git (args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()

    throw new GitError(stderr || `git ${args[0]} failed: ${(error as Error).message}`)
  }
}

/**
 * Every file that differs from `base`, including work that is not committed yet.
 *
 * Three dots rather than two, so the comparison is against the merge base. On a
 * branch that is behind main, two dots would report every file someone else
 * changed on main as changed here, and the run would cover far more than it
 * needed to. Uncommitted work is included because a developer running this
 * locally has not committed yet, and a tool that ignored their edits would tell
 * them their change was fine without having looked at it.
 */
export function changedFiles (projectRoot: string, base: string): string[] {
  let root: string
  // git answers with the real path, and on macOS the project is often reached
  // through a symlink (/tmp, /var). Comparing the two forms directly produces a
  // relative path full of "../" that matches nothing in the stats file, and a
  // run that matches nothing looks exactly like a run where nothing changed.
  const here = fs.realpathSync(projectRoot)

  try {
    root = fs.realpathSync(git(['rev-parse', '--show-toplevel'], projectRoot).trim())
  } catch (error) {
    throw new GitError(
      `Could not ask git what changed (${(error as Error).message}). ` +
      'Running only the affected stories needs a git repository.',
    )
  }

  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], projectRoot)
  } catch {
    throw new GitError(`"${base}" is not a commit this repository knows about. Fetch it, or pass another --since.`)
  }

  const committed = git(['diff', '--name-only', `${base}...HEAD`], projectRoot)
  const uncommitted = git(['status', '--porcelain', '--untracked-files=all'], projectRoot)

  const paths = [
    ...committed.split('\n'),
    // "XY path", and " M path" for a modified file, so the status columns and
    // the single space after them come off the front.
    ...uncommitted.split('\n').map((line) => line.slice(3)),
    // A rename reads as "old -> new" and both ends are a change.
  ].flatMap((line) => line.trim().split(' -> '))

  const relative = paths
    .filter((file) => file.length > 0)
    // git speaks in repository-relative paths and the stats file speaks in
    // project-relative ones, which are only the same thing when the Storybook
    // is at the top of the repository. In this project's own examples it is not.
    //
    // Files above the project keep their "../" and are handed on rather than
    // dropped. In a monorepo they are usually a package the Storybook imports,
    // and dropping them would be the one mistake this feature cannot afford. A
    // backend commit will therefore bail to a full run until someone puts it in
    // "untraced", which is the right way round.
    .map((file) => path.relative(here, path.join(root, file)).split(path.sep).join('/'))
    .filter((file) => file.length > 0)

  return [...new Set(relative)].sort()
}
