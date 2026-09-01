import type { StoryEntry } from './types.js'

/**
 * Splitting one run across several CI machines. TB-356.
 *
 * The addon already runs targets in parallel (resolveConcurrency in runner.ts),
 * which is a different axis: it helps when there are many browsers and does
 * nothing when there are many stories. This splits the stories instead, so a
 * project with a thousand of them can put a quarter on each of four machines.
 *
 * Two things make this harder than slicing an array.
 *
 * The split has to be identical on every machine without any of them talking to
 * each other. Each shard therefore derives its own slice from the story index
 * alone, sorted by id, and never from the order Storybook happened to publish
 * (which is a glob artifact and can differ between a cold and a warm build).
 * If two machines disagreed about the ordering, some stories would be captured
 * twice and others not at all, and the run would still be green.
 *
 * And a shard cannot claim the project passed. `RunResult.ok` means "everything
 * this run covered matched", which is what the exit code has to be or every
 * shard job would fail by design; `RunResult.partial` is what says the run was
 * not the whole project. Whatever collects the shards is what turns a set of
 * green shards into a green project.
 */

/** What the flags asked for, before the story count is known. */
export type ShardRequest = {
  /** Counting from zero, as Percy's --shard-index does. */
  index: number
  /** How many shards there are. Mutually exclusive with size. */
  count: number | null
  /** How many stories per shard, from which the count is derived. */
  size: number | null
}

/** A resolved shard: this one, out of that many. */
export type ShardSpec = {
  index: number
  count: number
}

export class ShardError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ShardError'
  }
}

/**
 * Everything that can be checked without knowing how many stories there are.
 * Called from the CLI so a contradictory pair of flags fails before a Storybook
 * build rather than after it.
 */
export function validateShardRequest (request: ShardRequest): void {
  const { index, count, size } = request

  if (count !== null && size !== null) {
    throw new ShardError('Pass either --shard-count or --shard-size, not both. They both say how big a shard is.')
  }

  if (count === null && size === null) {
    throw new ShardError('--shard-index needs --shard-count or --shard-size to know how many shards there are.')
  }

  for (const [flag, value] of [['--shard-count', count], ['--shard-size', size]] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      throw new ShardError(`${flag} must be a whole number of at least 1, not ${String(value)}.`)
    }
  }

  if (!Number.isInteger(index) || index < 0) {
    throw new ShardError(`--shard-index counts from 0, so it cannot be ${String(index)}.`)
  }
}

/**
 * Turns the request into a concrete shard now that the total is known.
 *
 * Out of range is an error rather than an empty run, because an index past the
 * end is a CI matrix that does not match the flags, and the stories that
 * nobody claimed would otherwise go uncaptured in silence.
 */
export function resolveShard (request: ShardRequest, total: number): ShardSpec {
  validateShardRequest(request)

  const { index, count: requested, size } = request
  const count = requested ?? Math.max(1, Math.ceil(total / (size as number)))

  if (index >= count) {
    const derived = requested === null ? ` (--shard-size ${size} over ${total} stories makes ${count})` : ''

    throw new ShardError(
      `--shard-index ${index} is out of range: there ${count === 1 ? 'is' : 'are'} ${count} ` +
      `shard${count === 1 ? '' : 's'}${derived}, numbered 0 to ${count - 1}.`,
    )
  }

  return { index, count }
}

/**
 * The stories this shard is responsible for.
 *
 * Sorted by id first, then cut into contiguous blocks that differ in size by at
 * most one. Contiguous rather than round robin so a shard's stories stay near
 * each other alphabetically, which keeps a component's stories together and
 * makes a shard's log readable; balanced rather than fixed blocks of
 * ceil(total / count) so that a count larger than it needs to be does not leave
 * the last shards with nothing while the first ones do all the work. Percy
 * takes the fixed-block route and can hand out empty trailing shards; the
 * difference only shows when the counts do not divide evenly.
 *
 * A shard can still legitimately come back empty, when there are more shards
 * than stories. That is a CI matrix wider than the project, not a mistake, and
 * the runner reports it as a run that covered nothing rather than as a failure.
 */
export function applyShard (stories: StoryEntry[], shard: ShardSpec): StoryEntry[] {
  const ordered = [...stories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const base = Math.floor(ordered.length / shard.count)
  const extra = ordered.length % shard.count

  // The first `extra` shards carry one more story than the rest.
  const start = shard.index * base + Math.min(shard.index, extra)
  const size = base + (shard.index < extra ? 1 : 0)

  return ordered.slice(start, start + size)
}
