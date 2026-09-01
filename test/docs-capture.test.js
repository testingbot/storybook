import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

import {
  fetchStoryIndex,
  isAutodocs,
  partitionSkipped,
  selectStories,
  storyUrl,
} from '../dist/index.js'

const require = createRequire(import.meta.url)
const { normaliseConfig, mergeOptions } = require('../src/server/projectConfig.cjs')

/**
 * TB-357. Docs pages are a second kind of page, not a second kind of story:
 * different viewMode, different root element, and off unless asked for. The
 * failure this is written against is a docs capture that silently produces a
 * blank image because it waited for the story root on a docs page.
 *
 * The tags below are copied from a real Storybook 10.5.10 build of
 * examples/kitchen-sink, not invented: an autodocs page carries `autodocs`, a
 * hand written page carries `unattached-mdx`, and a story of an autodocs
 * component carries `autodocs` too, which is why the tag alone means nothing.
 */

const INDEX = {
  v: 5,
  entries: {
    'basics-button--docs': {
      id: 'basics-button--docs',
      title: 'Basics/Button',
      name: 'Docs',
      type: 'docs',
      tags: ['dev', 'test', 'manifest', 'autodocs'],
    },
    'basics-palette--docs': {
      id: 'basics-palette--docs',
      title: 'Basics/Palette',
      name: 'Docs',
      type: 'docs',
      tags: ['dev', 'test', 'manifest', 'unattached-mdx'],
    },
    'basics-button--primary': {
      id: 'basics-button--primary',
      title: 'Basics/Button',
      name: 'Primary',
      type: 'story',
      tags: ['dev', 'test', 'manifest', 'autodocs'],
    },
    'basics-button--secondary': {
      id: 'basics-button--secondary',
      title: 'Basics/Button',
      name: 'Secondary',
      type: 'story',
      tags: ['dev', 'test', 'manifest', 'autodocs'],
    },
    'meta--only': { id: 'meta--only', type: 'component', title: 'Nothing' },
  },
}

async function serveIndex (body) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function entries () {
  return [
    { id: 'basics-button--docs', title: 'Basics/Button', name: 'Docs', type: 'docs', tags: ['autodocs'] },
    { id: 'basics-palette--docs', title: 'Basics/Palette', name: 'Docs', type: 'docs', tags: ['unattached-mdx'] },
    { id: 'basics-button--primary', title: 'Basics/Button', name: 'Primary', type: 'story', tags: ['autodocs'] },
    { id: 'basics-button--secondary', title: 'Basics/Button', name: 'Secondary', type: 'story', tags: ['autodocs'] },
  ]
}

test('the index keeps docs entries and nothing else that is not a story', async () => {
  const server = await serveIndex(INDEX)

  try {
    const found = await fetchStoryIndex(server.url)

    assert.deepEqual(found.map((entry) => entry.id).sort(), [
      'basics-button--docs',
      'basics-button--primary',
      'basics-button--secondary',
      'basics-palette--docs',
    ])
    // A "component" entry is not a page and has no URL worth opening.
    assert.equal(found.some((entry) => entry.id === 'meta--only'), false)
    assert.deepEqual(
      found.find((entry) => entry.id === 'basics-palette--docs').tags,
      ['dev', 'test', 'manifest', 'unattached-mdx'],
    )
  } finally {
    await server.close()
  }
})

test('the autodocs tag only means autodocs on a docs entry', () => {
  const [autodocs, mdx, story] = entries()

  assert.equal(isAutodocs(autodocs), true)
  assert.equal(isAutodocs(mdx), false)
  // The story inherited the tag from its meta. Reading it as a docs page would
  // capture every story in the project twice.
  assert.equal(isAutodocs(story), false)
})

test('docs pages are left out unless the project asks for them, by kind', () => {
  const ids = (options) => selectStories(entries(), options).map((entry) => entry.id).sort()

  assert.deepEqual(ids({}), ['basics-button--primary', 'basics-button--secondary'])

  assert.deepEqual(ids({ captureAutodocs: true }), [
    'basics-button--docs',
    'basics-button--primary',
    'basics-button--secondary',
  ])

  assert.deepEqual(ids({ captureDocs: true }), [
    'basics-button--primary',
    'basics-button--secondary',
    'basics-palette--docs',
  ])

  assert.deepEqual(ids({ captureDocs: true, captureAutodocs: true }).length, 4)
})

test('exclude still wins over a docs page the project asked for', () => {
  const picked = selectStories(entries(), {
    captureDocs: true,
    captureAutodocs: true,
    exclude: ['*--docs'],
  })

  assert.deepEqual(picked.map((entry) => entry.id), [
    'basics-button--primary',
    'basics-button--secondary',
  ])
})

test('naming one docs page by id runs it whatever the settings say', () => {
  // Asking for a page by id is an explicit request for it. Answering "nothing
  // matched" because captureDocs is off would send the developer looking at
  // their globs rather than at the setting.
  const picked = selectStories(entries(), { storyId: 'basics-palette--docs' })

  assert.deepEqual(picked.map((entry) => entry.id), ['basics-palette--docs'])
})

test('a docs page is opened in docs viewMode, and a story is not', () => {
  const [docs, , story] = entries()

  assert.equal(
    storyUrl('http://localhost:6006', docs, undefined).url,
    'http://localhost:6006/iframe.html?id=basics-button--docs&viewMode=docs',
  )
  assert.equal(
    storyUrl('http://localhost:6006', story, undefined).url,
    'http://localhost:6006/iframe.html?id=basics-button--primary&viewMode=story',
  )
})

test('an autodocs page is skipped when the meta that generated it skipped every story', () => {
  const all = entries()
  const { run, skipped } = partitionSkipped(all, {
    'basics-button--primary': { skip: true },
    'basics-button--secondary': { skip: true },
  })

  // Docs pages have no parameters of their own, so without this a component
  // marked skip would still be photographed through its docs page.
  assert.deepEqual(skipped.map((entry) => entry.id).sort(), [
    'basics-button--docs',
    'basics-button--primary',
    'basics-button--secondary',
  ])
  // Nobody said anything about the unattached page, so it runs.
  assert.deepEqual(run.map((entry) => entry.id), ['basics-palette--docs'])
})

test('one skipped story does not take its component docs page with it', () => {
  const { run } = partitionSkipped(entries(), { 'basics-button--primary': { skip: true } })

  assert.equal(run.some((entry) => entry.id === 'basics-button--docs'), true)
})

test('the config layer treats capture settings as strictly true or false', () => {
  const { config } = normaliseConfig({})

  assert.equal(config.captureDocs, false)
  assert.equal(config.captureAutodocs, false)

  // "yes" is a mistake, and reading it as true bills for every docs page.
  assert.equal(normaliseConfig({ captureDocs: 'yes' }).config.captureDocs, false)
  assert.equal(normaliseConfig({ captureDocs: 1 }).config.captureDocs, false)
  assert.equal(normaliseConfig({ captureDocs: true }).config.captureDocs, true)

  // main.js still overrides the file, like every other option.
  assert.equal(mergeOptions(config, { captureAutodocs: true }).captureAutodocs, true)
})
