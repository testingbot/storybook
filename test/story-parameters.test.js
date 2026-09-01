import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PARAMETER_KEY, partitionSkipped, storyUrl, toParameterMap } from '../dist/index.js'

/** An index entry, which is what storyUrl and partitionSkipped work on. */
function entry (id, extra = {}) {
  return { id, title: 'Basics/Button', name: id, type: 'story', tags: [], ...extra }
}

/**
 * TB-353: per-story configuration read from Storybook's own parameters.
 *
 * Everything here validates what came back from a page. The page ran the
 * project's own code, so the shape is whatever the developer typed, and a
 * mistyped parameter that silently does nothing is the failure mode this is
 * written against.
 */

test('the three supported parameters are read, and the rest of the story is ignored', () => {
  const { params, warnings } = toParameterMap({
    parameters: {
      'button--primary': { skip: true },
      'card--loading': { waitForSelector: '.loaded', args: { state: 'ready' } },
      'card--plain': {},
    },
    allowedGlobals: null,
  })

  assert.deepEqual(params['button--primary'], { skip: true })
  assert.deepEqual(params['card--loading'], { waitForSelector: '.loaded', args: { state: 'ready' } })
  // A story with no parameters of ours does not need an entry.
  assert.equal(params['card--plain'], undefined)
  assert.deepEqual(warnings, [])
})

test('a misspelled parameter is named rather than silently ignored', () => {
  const { params, warnings } = toParameterMap({
    parameters: { 'button--primary': { waitforSelector: '.loaded' } },
  })

  assert.equal(params['button--primary'], undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /waitforSelector/)
  assert.match(warnings[0], new RegExp(PARAMETER_KEY))
})

test('a parameter of the wrong type is refused, and its siblings still apply', () => {
  const { params, warnings } = toParameterMap({
    parameters: {
      's--one': { skip: 'yes', waitForSelector: '.ready' },
      's--two': { waitForSelector: '   ' },
      's--three': { args: ['not', 'an', 'object'] },
    },
  })

  assert.deepEqual(params['s--one'], { waitForSelector: '.ready' })
  assert.equal(params['s--two'], undefined)
  assert.equal(params['s--three'], undefined)
  assert.equal(warnings.length, 3)
})

test('a page that answers with nothing is not an error', () => {
  // No preview to read is reported by the caller, not treated as bad data here.
  assert.deepEqual(toParameterMap(null), { params: {}, warnings: [] })
  assert.deepEqual(toParameterMap(undefined), { params: {}, warnings: [] })
})

test('a page that answers with the wrong shape says so once', () => {
  for (const raw of [['button--primary'], { parameters: ['button--primary'] }, { allowedGlobals: [] }]) {
    const { params, warnings } = toParameterMap(raw)

    assert.deepEqual(params, {})
    assert.equal(warnings.length, 1)
  }
})

test('skipped stories are separated, not dropped', () => {
  const stories = [{ id: 'a--one' }, { id: 'b--two' }, { id: 'c--three' }]

  const { run, skipped } = partitionSkipped(stories, {
    'b--two': { skip: true },
    'c--three': { skip: false },
  })

  assert.deepEqual(run.map((story) => story.id), ['a--one', 'c--three'])
  assert.deepEqual(skipped.map((story) => story.id), ['b--two'])
})

test('args become Storybook\'s own URL parameter, unencoded', () => {
  const { url } = storyUrl('http://localhost:6006/', entry('button--primary'), {
    args: { label: 'Save changes', disabled: true },
  })

  // The separators have to survive: Storybook's parser splits on the literal
  // ";" and ":", so percent-encoding them would lose the args entirely.
  assert.equal(
    url,
    'http://localhost:6006/iframe.html?id=button--primary&viewMode=story&args=label:Save+changes;disabled:!true',
  )
})

test('a story with no args gets the plain URL, and the story id is still escaped', () => {
  assert.deepEqual(storyUrl('http://localhost:6006', entry('button--primary'), undefined), {
    url: 'http://localhost:6006/iframe.html?id=button--primary&viewMode=story',
    rejected: [],
  })

  assert.deepEqual(storyUrl('http://localhost:6006', entry('button--primary'), { args: {} }).url,
    'http://localhost:6006/iframe.html?id=button--primary&viewMode=story')

  const { url } = storyUrl('http://localhost:6006', entry('a&b--c'), undefined)
  assert.match(url, /id=a%26b--c/)
})

test('an arg Storybook would refuse is named and the rest still travel', () => {
  const { url, rejected } = storyUrl('http://localhost:6006', entry('button--primary'), {
    args: { label: 'Save', html: '<img onerror=alert(1)>' },
  })

  assert.match(url, /&args=label:Save$/)
  assert.deepEqual(rejected, ['args.html'])
})

/**
 * Globals and queryParams. Globals are the theme and locale switch, and they
 * are encoded exactly as args are because Storybook parses both with the same
 * function. queryParams are ordinary parameters and are encoded normally.
 */

test('globals travel as their own parameter, in the args encoding', () => {
  const { url, rejected } = storyUrl('http://localhost:6006', entry('button--primary'), {
    args: { label: 'Save' },
    globals: { theme: 'dark', locale: 'en-GB' },
  })

  assert.equal(
    url,
    'http://localhost:6006/iframe.html?id=button--primary&viewMode=story' +
    '&args=label:Save&globals=theme:dark;locale:en-GB',
  )
  assert.deepEqual(rejected, [])
})

test('a rejected key says which parameter it came from', () => {
  // "theme" is a plausible name for both, so an unqualified name would leave
  // the developer editing the wrong object.
  const { rejected } = storyUrl('http://localhost:6006', entry('button--primary'), {
    args: { theme: '<b>' },
    globals: { theme: '<b>' },
  })

  assert.deepEqual(rejected, ['args.theme', 'globals.theme'])
})

test('queryParams are encoded the ordinary way, unlike args and globals', () => {
  const { url } = storyUrl('http://localhost:6006', entry('button--primary'), {
    queryParams: { token: 'a b&c', retries: 3, debug: true },
  })

  assert.match(url, /&token=a%20b%26c&retries=3&debug=true$/)
})

test('a query parameter the addon sets itself is refused, not merged', () => {
  // Two id parameters would screenshot another story under this story's name:
  // green, and about the wrong thing.
  const { params, warnings } = toParameterMap({
    parameters: {
      'button--primary': { queryParams: { id: 'other--story', viewMode: 'docs', theme: 'dark' } },
    },
  })

  assert.deepEqual(params['button--primary'], { queryParams: { theme: 'dark' } })
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every((warning) => /addon sets itself/.test(warning)))

  const { url } = storyUrl('http://localhost:6006', entry('button--primary'), params['button--primary'])

  assert.equal(url.match(/id=/g).length, 1)
})

test('a query parameter that is not a scalar is refused, and its siblings still travel', () => {
  const { params, warnings } = toParameterMap({
    parameters: { 'button--primary': { queryParams: { good: 'yes', bad: { nested: true } } } },
  })

  assert.deepEqual(params['button--primary'], { queryParams: { good: 'yes' } })
  assert.equal(warnings.length, 1)
})

test('a global this Storybook does not declare is named, because Storybook drops it in silence', () => {
  // Storybook filters URL globals against initialGlobals and globalTypes and
  // warns only in the page's own console, so from out here the story just
  // renders with its default and the run goes green about the wrong picture.
  const { params, warnings } = toParameterMap({
    parameters: { 'button--primary': { globals: { theme: 'dark', thmee: 'dark' } } },
    allowedGlobals: ['theme', 'locale'],
  })

  assert.deepEqual(params['button--primary'].globals, { theme: 'dark', thmee: 'dark' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /thmee/)
})

test('when the page could not say which globals exist, none of them are accused', () => {
  // Best effort on a Storybook internal. A false accusation about a working
  // global is worse than saying nothing.
  const { warnings } = toParameterMap({
    parameters: { 'button--primary': { globals: { anything: 'at all' } } },
    allowedGlobals: null,
  })

  assert.deepEqual(warnings, [])
})
