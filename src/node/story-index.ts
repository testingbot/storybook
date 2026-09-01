import type { StoryEntry } from './types.js'

/**
 * Story enumeration.
 *
 * Storybook publishes everything it knows about at /index.json. Reading that
 * turns "test my components" into a concrete list with nothing to keep in sync
 * by hand, which is how the proven spec in the example repo works
 * (tests/storybook.spec.mjs).
 *
 * Docs pages come back too, but nothing runs them unless the project asks:
 * see selectStories. A docs page is a real page that can regress, and for a
 * design system it is often the page people actually look at, but it is mostly
 * a composition of stories that are already covered one by one, so paying for a
 * grid session per docs page is a choice rather than a default. TB-357.
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

type RawEntry = {
  id?: string
  title?: string
  name?: string
  type?: string
  tags?: unknown
}

type RawIndex = {
  v?: number
  entries?: Record<string, RawEntry>
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
    .filter((entry) => entry && typeof entry.id === 'string')
    .filter((entry) => entry.type === 'story' || entry.type === 'docs')
    .map((entry) => ({
      id: entry.id as string,
      title: entry.title ?? '',
      name: entry.name ?? '',
      type: entry.type as 'story' | 'docs',
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    }))
}

/**
 * A generated autodocs page, as opposed to a hand written MDX one.
 *
 * The tag is only meaningful on a docs entry: a story inherits `autodocs` from
 * the meta that generated the page, so testing the tag alone would call every
 * story in an autodocs component a docs page.
 */
export function isAutodocs (entry: StoryEntry): boolean {
  return entry.type === 'docs' && entry.tags.includes('autodocs')
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
 * Applies scope, docs capture, include and exclude in that order.
 *
 * Exclude wins over include, which is the convention every tool with both
 * settings uses, and the only one that lets "everything in this folder except
 * the flaky one" be expressed.
 *
 * A named `storyId` skips the docs settings entirely. Asking for one page by id
 * is an explicit request for that page, and answering "no stories matched"
 * because a setting the developer did not know about is off would send them
 * looking in the wrong place.
 */
export function selectStories (
  stories: StoryEntry[],
  {
    storyId = null,
    include = [],
    exclude = [],
    captureDocs = false,
    captureAutodocs = false,
  }: {
    storyId?: string | null
    include?: string[]
    exclude?: string[]
    captureDocs?: boolean
    captureAutodocs?: boolean
  } = {},
): StoryEntry[] {
  if (storyId) {
    return stories.filter((story) => story.id === storyId)
  }

  return stories
    .filter((story) => {
      if (story.type !== 'docs') return true

      return isAutodocs(story) ? captureAutodocs : captureDocs
    })
    .filter((story) => (include.length === 0 ? true : matchesAny(story, include)))
    .filter((story) => !matchesAny(story, exclude))
}
