import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyShard, resolveShard, validateShardRequest, ShardError } from '../dist/index.js'
import { parseCliArgs } from '../dist/cli.js'

/**
 * TB-356. Splitting a run across CI machines.
 *
 * The failure this is written against is not a crash. It is four green shards
 * that between them never captured one of the stories, because two machines
 * disagreed about the ordering or about how many shards there were. Every test
 * below is about the whole set of stories being covered exactly once.
 */

function stories (n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s-${String(i).padStart(2, '0')}--one`,
    title: 'Basics/Button',
    name: 'One',
    type: 'story',
    tags: [],
  }))
}

/** Every story, once, in shard order. */
function union (all, count, size = null) {
  const seen = []

  for (let index = 0; index < count; index += 1) {
    seen.push(...applyShard(all, resolveShard({ index, count: size ? null : count, size }, all.length)))
  }

  return seen.map((story) => story.id)
}

test('the shards together cover every story exactly once', () => {
  for (const total of [0, 1, 5, 10, 17, 100]) {
    for (const count of [1, 2, 3, 4, 7]) {
      const all = stories(total)
      const covered = union(all, count)

      assert.deepEqual(
        covered.slice().sort(),
        all.map((story) => story.id).sort(),
        `${total} stories over ${count} shards`,
      )
      // Once, not twice: a duplicate is two machines capturing the same story
      // and one story captured by nobody.
      assert.equal(new Set(covered).size, covered.length)
    }
  }
})

test('shards differ in size by at most one, and none is empty unless it has to be', () => {
  const all = stories(10)
  const sizes = [0, 1, 2].map((index) => applyShard(all, { index, count: 3 }).length)

  assert.deepEqual(sizes, [4, 3, 3])

  // Percy cuts fixed blocks of ceil(total / count), which hands shard 3 nothing
  // at all here while shard 0 does a third of the work.
  const fours = [0, 1, 2, 3].map((index) => applyShard(stories(5), { index, count: 4 }).length)

  assert.deepEqual(fours, [2, 1, 1, 1])
})

test('a shard is decided by the story ids, not by the order the index arrived in', () => {
  const all = stories(9)
  const shuffled = [all[4], all[0], all[8], all[2], all[6], all[1], all[7], all[3], all[5]]

  // Two machines build the same commit but need not receive the same ordering,
  // and a disagreement here is a story nobody captures.
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(
      applyShard(all, { index, count: 3 }).map((story) => story.id),
      applyShard(shuffled, { index, count: 3 }).map((story) => story.id),
    )
  }

  assert.deepEqual(
    applyShard(all, { index: 0, count: 3 }).map((story) => story.id),
    ['s-00--one', 's-01--one', 's-02--one'],
  )
})

test('a shard count is derived from a shard size, and no shard exceeds it', () => {
  assert.deepEqual(resolveShard({ index: 0, count: null, size: 4 }, 10), { index: 0, count: 3 })
  assert.deepEqual(resolveShard({ index: 0, count: null, size: 3 }, 10), { index: 0, count: 4 })

  const all = stories(10)

  for (let index = 0; index < 4; index += 1) {
    assert.ok(applyShard(all, { index, count: 4 }).length <= 3)
  }

  // Everything on one machine is a legal thing to ask for.
  assert.deepEqual(resolveShard({ index: 0, count: null, size: 500 }, 10), { index: 0, count: 1 })
})

test('an index past the end is refused rather than run as nothing', () => {
  // A silent empty run here is the dangerous case: the CI matrix and the flags
  // disagree, and the stories that index would have covered are captured by
  // nobody while every job stays green.
  assert.throws(() => resolveShard({ index: 3, count: 3, size: null }, 30), (error) => {
    assert.ok(error instanceof ShardError)
    assert.match(error.message, /numbered 0 to 2/)

    return true
  })

  assert.throws(() => resolveShard({ index: 4, count: null, size: 10 }, 30), /--shard-size 10 over 30 stories/)
})

test('an empty shard is allowed when there are more shards than stories', () => {
  // A CI matrix wider than the project is wasteful, not wrong, and must not
  // fail the job that drew the short straw.
  const all = stories(2)

  assert.deepEqual(applyShard(all, { index: 0, count: 4 }).map((s) => s.id), ['s-00--one'])
  assert.deepEqual(applyShard(all, { index: 3, count: 4 }), [])
})

test('contradictory shard flags are refused before anything is built', () => {
  assert.throws(
    () => validateShardRequest({ index: 0, count: 4, size: 10 }),
    /not both/,
  )
  assert.throws(
    () => validateShardRequest({ index: 0, count: null, size: null }),
    /needs --shard-count or --shard-size/,
  )
  assert.throws(() => validateShardRequest({ index: -1, count: 2, size: null }), /counts from 0/)
  assert.throws(() => validateShardRequest({ index: 0, count: 0, size: null }), /at least 1/)
})

test('the CLI reads the shard flags, and refuses a half written set of them', () => {
  const options = parseCliArgs(['--shard-count', '4', '--shard-index', '2'])

  assert.deepEqual(options.shard, { index: 2, count: 4, size: null })
  // Sharding is partial by nature, but the runner is what decides that; the
  // flag is only what a run says about itself when it is not sharded.
  assert.equal(options.partial, false)

  assert.equal(parseCliArgs([]).shard, null)
  assert.equal(parseCliArgs(['--partial']).partial, true)

  // A count with no index would run shard 0 on every machine in the matrix:
  // the same quarter of the project four times over, all green.
  assert.throws(() => parseCliArgs(['--shard-count', '4']), /--shard-index/)
  assert.throws(() => parseCliArgs(['--shard-index', '2']), /--shard-count or --shard-size/)
  assert.throws(() => parseCliArgs(['--shard-index', 'two', '--shard-count', '4']), /whole number/)
  // Number('') is 0, which would silently be a valid shard index.
  assert.throws(() => parseCliArgs(['--shard-index', '', '--shard-count', '4']), /whole number/)
})
