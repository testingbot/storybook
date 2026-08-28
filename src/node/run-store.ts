import fs from 'node:fs'
import path from 'node:path'

import { baselinePath, resultPath, resultsDir, writeImage } from './baselines.js'
import type { RunResult, StoryResult } from './types.js'

/**
 * The last run, on disk.
 *
 * The panel is a browser context inside a dev server that restarts whenever a
 * config file changes, so keeping the last run only in the manager's memory
 * means a developer loses their review list every time Vite reloads. Writing it
 * next to the screenshots it describes makes the results view survive a reload,
 * a Storybook restart, and a switch to the CLI.
 *
 * It lives under results/, not baselines/, because it is per-run output and
 * belongs in the same gitignore line as the PNGs it points at.
 */

const LAST_RUN_FILE = 'last-run.json'
/** Bumped when the shape changes, so a stale file is ignored rather than misread. */
const STORE_VERSION = 1

type StoredRun = {
  version: number
  finishedAt: string
  result: RunResult
}

export function lastRunPath (projectRoot: string): string {
  return path.join(resultsDir(projectRoot), LAST_RUN_FILE)
}

export function writeLastRun (projectRoot: string, result: RunResult): void {
  const file = lastRunPath(projectRoot)
  const stored: StoredRun = { version: STORE_VERSION, finishedAt: new Date().toISOString(), result }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
}

/**
 * Returns null rather than throwing for every failure mode: no run yet, a file
 * from an older version, a half-written file. None of those are errors the
 * developer needs to see; they all mean the same thing, which is "there is
 * nothing to review".
 */
export function readLastRun (projectRoot: string): StoredRun | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lastRunPath(projectRoot), 'utf8')) as StoredRun

    if (parsed?.version !== STORE_VERSION || !parsed.result) return null

    return parsed
  } catch {
    return null
  }
}

export type ImageKind = 'baseline' | 'actual' | 'diff'

/**
 * Reads one screenshot as a data URL for the panel.
 *
 * The manager runs in the browser and cannot read the filesystem, so the bytes
 * have to travel. They go over the existing server channel as base64 rather
 * than through a new HTTP route, for two reasons: the channel is already behind
 * the nonce guard, and adding a static route would mean a second experimental
 * Storybook surface to re-verify on every upgrade.
 *
 * Images are fetched one at a time, on demand, when a developer opens a story
 * in the results view. A component crop is tens of kilobytes, so this is cheap;
 * sending every image of a 200-story run up front would not be.
 *
 * As in approveStory, the path is derived from identifiers and never taken from
 * the caller, so this cannot be used to read arbitrary files.
 */
export function readImageDataUrl (
  projectRoot: string,
  storyId: string,
  target: string,
  kind: ImageKind,
): string | null {
  const file =
    kind === 'baseline'
      ? baselinePath(projectRoot, target, storyId)
      : resultPath(projectRoot, target, storyId, kind)

  try {
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

export type ApprovalOutcome = {
  storyId: string
  target: string
  approved: boolean
  message?: string
}

/**
 * Promotes this run's screenshot to the baseline for one story on one target.
 *
 * Paths are rebuilt from the story and target identifiers rather than taken
 * from the caller. The panel is reachable over a websocket, so accepting a path
 * from it would mean an event could copy any file on the machine into the
 * project, or read one out of it. The identifiers go through the same
 * sanitiser the runner used to write them, so an approval can only ever touch a
 * file the runner itself created.
 */
export function approveStory (
  projectRoot: string,
  storyId: string,
  target: string,
): ApprovalOutcome {
  const actual = resultPath(projectRoot, target, storyId, 'actual')
  const baseline = baselinePath(projectRoot, target, storyId)

  let image: Buffer

  try {
    image = fs.readFileSync(actual)
  } catch {
    return {
      storyId,
      target,
      approved: false,
      message: `No screenshot from this run for ${storyId} on ${target}. Run it again before approving.`,
    }
  }

  writeImage(baseline, image)

  // The diff described a comparison that no longer exists. Leaving it would
  // show a red overlay next to a story the developer just accepted.
  fs.rmSync(resultPath(projectRoot, target, storyId, 'diff'), { force: true })

  return { storyId, target, approved: true }
}

/**
 * Rewrites the stored run so approved stories read as passing.
 *
 * Without this the panel would keep showing a red diff next to a story the
 * developer just accepted, and the totals would stay wrong until the next run.
 * The alternative, re-running the comparison, would be slower and would say the
 * same thing: the baseline is now byte-identical to the result, so the
 * comparison can only come back equal.
 */
export function markApproved (projectRoot: string, approved: ApprovalOutcome[]): RunResult | null {
  const stored = readLastRun(projectRoot)

  if (!stored) return null

  const accepted = new Set(
    approved.filter((outcome) => outcome.approved).map((outcome) => `${outcome.target}::${outcome.storyId}`),
  )

  if (accepted.size === 0) return stored.result

  const stories = stored.result.stories.map((story) => {
    if (!accepted.has(`${story.target}::${story.storyId}`)) return story

    const { diffPath: _dropped, ...rest } = story

    return { ...rest, outcome: 'passed' as const, diffPixelRatio: 0 }
  })

  const totals: RunResult['totals'] = { new: 0, passed: 0, diff: 0, failed: 0 }

  for (const story of stories) {
    totals[story.outcome] += 1
  }

  const result: RunResult = {
    ...stored.result,
    stories,
    totals,
    ok: totals.diff === 0 && totals.failed === 0 && !stored.result.cancelled,
  }

  writeLastRun(projectRoot, result)

  return result
}

/**
 * Bulk approval, for the case this exists to serve: one intentional design
 * change that moved forty stories at once.
 *
 * Only stories that actually differ are eligible. Approving a passing story is
 * a no-op that rewrites an identical file, and approving a failed one would
 * promote whatever happened to be on screen when the story errored.
 */
export function approvableStories (result: RunResult): StoryResult[] {
  return result.stories.filter((story) => story.outcome === 'diff')
}
