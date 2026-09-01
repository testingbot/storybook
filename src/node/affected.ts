import type { StoryEntry } from './types.js'

/**
 * Running only the stories a change can affect. TB-358.
 *
 * On a grid every story is a paid session, so running four hundred of them
 * because three files changed is the largest avoidable cost in the product.
 * Percy calls their version IntelliStory and does the graph work on their
 * server; this does it here, from two files the build already produces.
 *
 * The whole design follows from one asymmetry. Running a story that could not
 * have changed wastes a session. Not running a story that did change produces a
 * green run that never looked at the broken component, which is worse than
 * being slow and is exactly the kind of quiet lie the rest of this addon goes
 * out of its way to avoid. So every judgement call here is made in the
 * direction of running too much, and anything not understood is a full run with
 * the reason said out loud.
 *
 * Concretely that means three rules:
 *
 * - A changed file that the module graph has never heard of is a full run. It
 *   could be a stylesheet pulled in by preview-head.html, a font, a public
 *   asset, a Tailwind config: things that change rendering without ever being
 *   imported. The message names the file, so `untraced` can be told about it
 *   once and never asked again.
 * - A changed file that is in the graph but reaches no story reaches the
 *   preview shell instead, which every story is rendered inside. Full run.
 * - Anything in `bailOnChanges` is a full run without tracing at all. The
 *   defaults are the files that can change every story at once: the Storybook
 *   config directory, the package manifest and lockfiles, and this addon's own
 *   config.
 *
 * The story end of the graph is not guessed at. Storybook's own index gives
 * each entry an `importPath`, which is the file it was defined in, in the same
 * "./src/Button.stories.jsx" form the stats file uses.
 */

/**
 * Files whose change can affect anything, so tracing them is pointless.
 *
 * The Storybook config directory is here for the same reason Percy has it: a
 * decorator added in preview.js wraps every story in the project.
 */
export const DEFAULT_BAIL_ON_CHANGES = [
  '.storybook/**',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  '.testingbot.json',
]

export type AffectedDecision =
  | { run: 'all'; reason: string }
  | { run: 'some'; storyIds: string[]; reason: string }

/** Module id to the ids of the modules that import it. */
export type ImporterGraph = Map<string, string[]>

export class StatsError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'StatsError'
  }
}

type RawStats = {
  modules?: { id?: unknown; name?: unknown; reasons?: { moduleName?: unknown }[] }[]
}

/**
 * Turns a Storybook preview stats file into "who imports this".
 *
 * Both builders write the same shape here: a flat list of modules, each with
 * the modules that pulled it in under `reasons`. That is already the reverse
 * direction, which is the one this needs, because the question is "what depends
 * on the file that changed" rather than "what does this story import".
 */
export function readImporterGraph (raw: unknown): ImporterGraph {
  const stats = raw as RawStats

  if (!stats || !Array.isArray(stats.modules)) {
    throw new StatsError('The stats file has no "modules" array. It is not a Storybook preview stats file.')
  }

  const graph: ImporterGraph = new Map()

  for (const module of stats.modules) {
    const id = typeof module?.id === 'string' ? module.id : typeof module?.name === 'string' ? module.name : null

    if (!id) continue

    const importers = (Array.isArray(module.reasons) ? module.reasons : [])
      .map((reason) => (typeof reason?.moduleName === 'string' ? reason.moduleName : null))
      .filter((name): name is string => name !== null && name !== id)

    graph.set(normalisePath(id), importers.map(normalisePath))
  }

  return graph
}

/**
 * Which stories a set of changed files can reach, or a reason to run everything.
 *
 * `changed` is project-relative, in whatever form git produced. Both ends are
 * normalised to the "./src/Button.jsx" form the stats file uses, because a run
 * that silently matched nothing would look exactly like a run where nothing
 * changed, and would skip every story in the project.
 */
export function decideAffected ({
  graph,
  stories,
  changed,
  untraced = [],
  bailOnChanges = DEFAULT_BAIL_ON_CHANGES,
}: {
  graph: ImporterGraph
  stories: StoryEntry[]
  changed: string[]
  untraced?: string[]
  bailOnChanges?: string[]
}): AffectedDecision {
  const byImportPath = new Map<string, StoryEntry[]>()

  for (const story of stories) {
    if (!story.importPath) {
      // An index without importPath is an older Storybook, and there is no
      // honest way to trace it. Better to run everything than to run a
      // half-empty set that looks deliberate.
      return {
        run: 'all',
        reason: `Storybook's index does not say which file "${story.id}" came from, so nothing can be traced.`,
      }
    }

    const key = normalisePath(story.importPath)

    byImportPath.set(key, [...(byImportPath.get(key) ?? []), story])
  }

  const interesting = changed
    .map(normalisePath)
    .filter((file) => !matchesPath(file, untraced))

  if (interesting.length === 0) {
    // Nothing that matters changed. Reported by the caller rather than turned
    // into an empty run here, because "run no stories" is a claim too.
    return { run: 'some', storyIds: [], reason: 'No traced file changed.' }
  }

  const bailed = interesting.find((file) => matchesPath(file, bailOnChanges))

  if (bailed) {
    return { run: 'all', reason: `${bailed} changed, and that can affect every story.` }
  }

  const reached = new Set<string>()

  for (const file of interesting) {
    if (!graph.has(file)) {
      return {
        run: 'all',
        reason: `${file} changed and is not in the module graph, so what it affects is unknown. ` +
          'Add it to "untraced" if it cannot affect a story.',
      }
    }

    const hits = storiesReachedBy(file, graph, byImportPath)

    if (hits.length === 0) {
      return {
        run: 'all',
        reason: `${file} changed and is imported by the preview itself rather than by any story.`,
      }
    }

    for (const id of hits) reached.add(id)
  }

  const storyIds = [...reached].sort()

  return {
    run: 'some',
    reason: `${interesting.length} changed file${interesting.length === 1 ? '' : 's'} ` +
      `reach${interesting.length === 1 ? 'es' : ''} ${storyIds.length} stor${storyIds.length === 1 ? 'y' : 'ies'}.`,
    storyIds,
  }
}

/**
 * Walks up the importers from one file until it lands on story files.
 *
 * Breadth first with a seen set, because a module graph has cycles in it and
 * because the shortest path to a story is the one worth reporting.
 */
function storiesReachedBy (
  file: string,
  graph: ImporterGraph,
  byImportPath: Map<string, StoryEntry[]>,
): string[] {
  const found = new Set<string>()
  const seen = new Set<string>([file])
  const queue = [file]

  while (queue.length > 0) {
    const current = queue.shift() as string

    for (const story of byImportPath.get(current) ?? []) found.add(story.id)

    for (const importer of graph.get(current) ?? []) {
      if (seen.has(importer)) continue

      seen.add(importer)
      queue.push(importer)
    }
  }

  return [...found]
}

/**
 * One path form, so both ends of the comparison agree.
 *
 * The stats file writes "./src/Button.jsx", git writes "src/Button.jsx", and a
 * Windows checkout writes backslashes. A mismatch here does not fail: it
 * silently matches nothing, which reads as "nothing changed" and skips the
 * whole project.
 */
function normalisePath (value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/^\.\//, '')

  return slashed.replace(/^\/+/, '')
}

/**
 * Glob matching for file paths, which is not the same as the story-id matching
 * in story-index.ts: there, `*` may cross anything because ids are flat. Here a
 * path has directories in it, so `*` stops at a slash and `**` does not.
 * "src/*.css" must not match "src/theme/dark.css".
 */
function matchesPath (file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(normalisePath(pattern)).test(file))
}

function globToRegExp (pattern: string): RegExp {
  let source = ''

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" also matches zero directories, so "src/**/x" matches "src/x".
        source += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*'
        i += pattern[i + 2] === '/' ? 2 : 1
      } else {
        source += '[^/]*'
      }

      continue
    }

    if (char === '?') {
      source += '[^/]'

      continue
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  return new RegExp(`^${source}$`)
}
