import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildArgsParam } from '../dist/index.js'
import { buildArgsParam as storybookBuildArgsParam } from 'storybook/internal/router'

/**
 * TB-353.
 *
 * src/node/story-args.ts is a copy of Storybook's encoder rather than a call to
 * it, so the copy has to be shown to still agree. Storybook's version diffs
 * against the story's initial args; ours has nothing to diff against, so it is
 * given `{}` as the initial args on their side, which makes every key an
 * update and the two comparable.
 */
function agrees (args) {
  assert.equal(buildArgsParam(args).param, storybookBuildArgsParam({}, args), JSON.stringify(args))
}

test('the args encoding matches the Storybook the addon is pinned to', () => {
  agrees({ label: 'Save' })
  agrees({ count: 3, ratio: -1.5 })
  agrees({ disabled: true, loading: false })
  agrees({ label: 'Save and close' })
  agrees({ missing: null })
  agrees({ colour: '#ff0000' })
  agrees({ colour: '#FFAA00CC' })
  agrees({ colour: 'rgba(0, 0, 0, 0.5)' })
  agrees({ theme: { mode: 'dark', dense: true } })
  agrees({ items: ['one', 'two'] })
  agrees({ theme: { palette: { primary: 'blue' } } })
  agrees({ rows: [{ id: 1 }, { id: 2 }] })
  agrees({ label: 'Save', disabled: true, count: 2, theme: { mode: 'dark' } })
})

test('a value Storybook would refuse is left out and named, not escaped', () => {
  // Escaping it would produce a URL Storybook drops on its own side, and the
  // story would then render with its default arg while the run looked fine.
  const { param, rejected } = buildArgsParam({ label: 'Save', html: '<script>alert(1)</script>' })

  assert.equal(param, 'label:Save')
  assert.deepEqual(rejected, ['html'])

  // And Storybook agrees that it is the unsafe one that goes.
  assert.equal(storybookBuildArgsParam({}, { label: 'Save' }), param)
})

test('an empty args object produces no parameter at all', () => {
  assert.deepEqual(buildArgsParam({}), { param: '', rejected: [] })
})
