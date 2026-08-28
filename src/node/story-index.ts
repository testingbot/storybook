import type { StoryEntry } from './types.js'

/**
 * Story enumeration.
 *
 * Storybook publishes everything it knows about at /index.json. Reading that
 * turns "test my components" into a concrete list with nothing to keep in sync
 * by hand, which is how the proven spec in the example repo works
 * (tests/storybook.spec.mjs).
 *
 * Non-story entries are filtered out: docs pages render MDX chrome, not the
 * component, so screenshotting them produces noise rather than coverage.
 */

const INDEX_TIMEOUT_MS = 30_000

export class StoryIndexError extends Error {
  code: string

  constructor (message: string, code = 'STORY_INDEX_FAILED') {
    super(message)
    this.name = 'StoryIndexError'
    this.code = code
  }
}

type RawIndex = {
  v?: number
  entries?: Record<string, { id?: string; title?: string; name?: string; type?: string }>
}

/**
 * Reads the index over plain HTTP from this machine, not through the tunnel.
 * The tunnel only exists so the cloud browser can reach the dev server; the
 * addon runs next to it and should not pay for a round trip to the grid just to
 * list stories.
 */
export async function fetchStoryIndex (
  devServerUrl: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<StoryEntry[]> {
  const indexUrl = new URL('index.json', ensureTrailingSlash(devServerUrl)).toString()

  let response: Response

  try {
    response = await fetch(indexUrl, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(INDEX_TIMEOUT_MS)]) : AbortSignal.timeout(INDEX_TIMEOUT_MS),
    })
  } catch (error) {
    if (signal?.aborted) throw error

    throw new StoryIndexError(
      `Could not read ${indexUrl} (${(error as Error).message}). Is Storybook running?`,
      'STORY_INDEX_UNREACHABLE',
    )
  }

  if (!response.ok) {
    throw new StoryIndexError(
      `Could not read ${indexUrl} (HTTP ${response.status}).`,
      'STORY_INDEX_UNREACHABLE',
    )
  }

  let index: RawIndex

  try {
    index = (await response.json()) as RawIndex
  } catch (error) {
    throw new StoryIndexError(`${indexUrl} did not return JSON (${(error as Error).message}).`)
  }

  const entries = index.entries

  if (!entries || typeof entries !== 'object') {
    throw new StoryIndexError(`${indexUrl} has no "entries". Storybook 10 is required.`)
  }

  return Object.values(entries)
    .filter((entry) => entry && entry.type === 'story' && typeof entry.id === 'string')
    .map((entry) => ({
      id: entry.id as string,
      title: entry.title ?? '',
      name: entry.name ?? '',
    }))
}

function ensureTrailingSlash (url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * Turns one glob into a regular expression.
 *
 * Deliberately tiny: story IDs are a flat kebab-case namespace like
 * `components-button--primary`, so `*` matching any run of characters is the
 * whole feature. Pulling in a glob library would add a dependency for one line
 * of behaviour, and `**` would mean nothing here because there is no hierarchy
 * to descend.
 */
function globToRegExp (pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const expanded = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')

  return new RegExp(`^${expanded}$`, 'i')
}

function matchesAny (story: StoryEntry, patterns: string[]): boolean {
  if (patterns.length === 0) return false

  const candidates = [story.id, story.title, `${story.title}/${story.name}`]

  return patterns.some((pattern) => {
    const matcher = globToRegExp(pattern)

    return candidates.some((candidate) => matcher.test(candidate))
  })
}

/**
 * Applies scope, include and exclude in that order.
 *
 * Exclude wins over include, which is the convention every tool with both
 * settings uses, and the only one that lets "everything in this folder except
 * the flaky one" be expressed.
 */
export function selectStories (
  stories: StoryEntry[],
  {
    storyId = null,
    include = [],
    exclude = [],
  }: { storyId?: string | null; include?: string[]; exclude?: string[] } = {},
): StoryEntry[] {
  if (storyId) {
    return stories.filter((story) => story.id === storyId)
  }

  return stories
    .filter((story) => (include.length === 0 ? true : matchesAny(story, include)))
    .filter((story) => !matchesAny(story, exclude))
}
