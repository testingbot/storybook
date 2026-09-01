import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PARAMETER_KEY, partitionSkipped, storyUrl, toParameterMap } from '../dist/index.js'

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
    'button--primary': { skip: true },
    'card--loading': { waitForSelector: '.loaded', args: { state: 'ready' } },
    'card--plain': {},
  })

  assert.deepEqual(params['button--primary'], { skip: true })
  assert.deepEqual(params['card--loading'], { waitForSelector: '.loaded', args: { state: 'ready' } })
  // A story with no parameters of ours does not need an entry.
  assert.equal(params['card--plain'], undefined)
  assert.deepEqual(warnings, [])
})

test('a misspelled parameter is named rather than silently ignored', () => {
  const { params, warnings } = toParameterMap({
    'button--primary': { waitforSelector: '.loaded' },
  })

  assert.equal(params['button--primary'], undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /waitforSelector/)
  assert.match(warnings[0], new RegExp(PARAMETER_KEY))
})

test('a parameter of the wrong type is refused, and its siblings still apply', () => {
  const { params, warnings } = toParameterMap({
    's--one': { skip: 'yes', waitForSelector: '.ready' },
    's--two': { waitForSelector: '   ' },
    's--three': { args: ['not', 'an', 'object'] },
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
  const { params, warnings } = toParameterMap(['button--primary'])

  assert.deepEqual(params, {})
  assert.equal(warnings.length, 1)
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
  const { url } = storyUrl('http://localhost:6006/', 'button--primary', {
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
  assert.deepEqual(storyUrl('http://localhost:6006', 'button--primary', undefined), {
    url: 'http://localhost:6006/iframe.html?id=button--primary&viewMode=story',
    rejected: [],
  })

  assert.deepEqual(storyUrl('http://localhost:6006', 'button--primary', { args: {} }).url,
    'http://localhost:6006/iframe.html?id=button--primary&viewMode=story')

  const { url } = storyUrl('http://localhost:6006', 'a&b--c', undefined)
  assert.match(url, /id=a%26b--c/)
})

test('an arg Storybook would refuse is named and the rest still travel', () => {
  const { url, rejected } = storyUrl('http://localhost:6006', 'button--primary', {
    args: { label: 'Save', html: '<img onerror=alert(1)>' },
  })

  assert.match(url, /&args=label:Save$/)
  assert.deepEqual(rejected, ['html'])
})
