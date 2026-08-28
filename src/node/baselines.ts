import fs from 'node:fs'
import path from 'node:path'

/**
 * Baseline storage.
 *
 * Layout, relative to the project root:
 *
 *   .testingbot/baselines/<target-key>/<story-id>.png   committed
 *   .testingbot/results/<target-key>/<story-id>.png     the run just taken
 *   .testingbot/results/<target-key>/<story-id>.diff.png a highlighted diff
 *
 * One baseline set per target key, because rendering differs per browser,
 * version and platform. Baselines are meant to be committed; results are not,
 * so they live in a sibling folder that is easy to gitignore in one line.
 *
 * Every baseline written here came from a grid session. The runner has no path
 * that screenshots locally, which is the point: a baseline taken on the
 * developer's machine would differ from every grid run and make the whole
 * feature useless.
 */

export const BASELINE_ROOT = '.testingbot'
const BASELINES_DIR = 'baselines'
const RESULTS_DIR = 'results'

/**
 * Story IDs come from Storybook and are already kebab-case, but they are user
 * data and end up in a path, so they are sanitised rather than trusted.
 */
function safeName (storyId: string): string {
  return storyId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '')
}

export function baselineDir (projectRoot: string): string {
  return path.join(projectRoot, BASELINE_ROOT, BASELINES_DIR)
}

export function resultsDir (projectRoot: string): string {
  return path.join(projectRoot, BASELINE_ROOT, RESULTS_DIR)
}

export function baselinePath (projectRoot: string, targetKey: string, storyId: string): string {
  return path.join(baselineDir(projectRoot), safeName(targetKey), `${safeName(storyId)}.png`)
}

export function resultPath (
  projectRoot: string,
  targetKey: string,
  storyId: string,
  kind: 'actual' | 'diff',
): string {
  const suffix = kind === 'diff' ? '.diff.png' : '.png'

  return path.join(resultsDir(projectRoot), safeName(targetKey), `${safeName(storyId)}${suffix}`)
}

export function readBaseline (file: string): Buffer | null {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

export function writeImage (file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}
