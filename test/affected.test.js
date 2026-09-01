import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import {
  changedFiles,
  decideAffected,
  readImporterGraph,
  DEFAULT_BAIL_ON_CHANGES,
  GitError,
  StatsError,
} from '../dist/index.js'
import { parseCliArgs } from '../dist/cli.js'

const require = createRequire(import.meta.url)
const { normaliseConfig, mergeOptions } = require('../src/server/projectConfig.cjs')

/**
 * TB-358. Running only the stories a change can reach.
 *
 * The failure worth writing tests against is not a crash. It is a green run
 * that never opened the component the developer broke. So most of what follows
 * checks that something unrecognised turns into a full run rather than into a
 * confident, small, wrong one.
 *
 * The stats shape is copied from a real Storybook 10.5.10 Vite build of
 * examples/kitchen-sink: a flat module list where each module names the modules
 * that imported it.
 */

const STATS = {
  modules: [
    { id: './iframe.html', name: './iframe.html', reasons: [{ moduleName: './iframe.html' }] },
    {
      id: './src/Button.stories.jsx',
      reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/storybook-stories.js' }],
    },
    {
      id: './src/Parameters.stories.jsx',
      reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/storybook-stories.js' }],
    },
    {
      id: './src/Button.jsx',
      reasons: [{ moduleName: './src/Button.stories.jsx' }, { moduleName: './src/Parameters.stories.jsx' }],
    },
    { id: './src/theme.css', reasons: [{ moduleName: './src/Button.jsx' }] },
    { id: './src/preview-only.js', reasons: [{ moduleName: './iframe.html' }] },
  ],
}

const STORIES = [
  { id: 'basics-button--primary', title: 'Basics/Button', name: 'Primary', type: 'story', tags: [], importPath: './src/Button.stories.jsx' },
  { id: 'basics-button--danger', title: 'Basics/Button', name: 'Danger', type: 'story', tags: [], importPath: './src/Button.stories.jsx' },
  { id: 'parameters-story--with-args', title: 'Parameters/Story', name: 'With args', type: 'story', tags: [], importPath: './src/Parameters.stories.jsx' },
]

const graph = () => readImporterGraph(STATS)

function decide (changed, extra = {}) {
  return decideAffected({ graph: graph(), stories: STORIES, changed, ...extra })
}

test('a change is traced up through the importers to the stories that use it', () => {
  // theme.css is two hops from a story: nothing imports it directly.
  const decision = decide(['src/theme.css'])

  assert.equal(decision.run, 'some')
  assert.deepEqual(decision.storyIds, [
    'basics-button--danger',
    'basics-button--primary',
    'parameters-story--with-args',
  ])
})

test('a story file reaches only its own stories', () => {
  const decision = decide(['src/Parameters.stories.jsx'])

  assert.deepEqual(decision.storyIds, ['parameters-story--with-args'])
})

test('the "./" the stats file writes and the plain path git writes are the same file', () => {
  // A mismatch here does not throw. It matches nothing, which reads as "nothing
  // changed" and skips the entire project, green.
  assert.deepEqual(decide(['./src/Button.jsx']).storyIds, decide(['src/Button.jsx']).storyIds)
  assert.equal(decide(['src/Button.jsx']).storyIds.length, 3)
})

test('a file the module graph has never heard of is a full run, and says which file', () => {
  const decision = decide(['public/fonts/inter.woff2'])

  assert.equal(decision.run, 'all')
  assert.match(decision.reason, /public\/fonts\/inter\.woff2/)
  assert.match(decision.reason, /untraced/)
})

test('a file that reaches the preview but no story is a full run', () => {
  // Something imported by the preview shell wraps every story that renders
  // inside it, so "it reaches no stories" is the opposite of "it affects none".
  const decision = decide(['src/preview-only.js'])

  assert.equal(decision.run, 'all')
  assert.match(decision.reason, /preview itself/)
})

test('the files that can change everything at once are a full run without tracing', () => {
  for (const file of ['.storybook/preview.js', 'package.json', 'package-lock.json', '.testingbot.json']) {
    const decision = decide([file])

    assert.equal(decision.run, 'all', file)
    assert.match(decision.reason, /can affect every story/)
  }

  assert.ok(DEFAULT_BAIL_ON_CHANGES.includes('.storybook/**'))

  // A project can replace the list, including with a smaller one.
  assert.equal(decide(['package.json'], { bailOnChanges: [] }).run, 'all') // still unknown to the graph
  assert.equal(decide(['src/Button.jsx'], { bailOnChanges: ['src/**'] }).run, 'all')
})

test('untraced files are ignored, and only they can make a run empty', () => {
  const decision = decide(['README.md', 'docs/guide.md'], { untraced: ['*.md', 'docs/**'] })

  assert.equal(decision.run, 'some')
  assert.deepEqual(decision.storyIds, [])
  assert.match(decision.reason, /No traced file changed/)

  // untraced does not silence a file that is genuinely traced.
  const mixed = decide(['README.md', 'src/Button.stories.jsx'], { untraced: ['*.md'] })

  assert.deepEqual(mixed.storyIds, ['basics-button--danger', 'basics-button--primary'])
})

test('a path glob stops at a directory boundary, unlike the story-id one', () => {
  // "src/*.css" must not swallow "src/theme/dark.css", or an untraced entry
  // meant for one file would silence a whole tree.
  assert.equal(decide(['src/theme.css'], { untraced: ['src/*.css'] }).storyIds.length, 0)
  assert.equal(decide(['src/theme.css'], { untraced: ['src/*/*.css'] }).run, 'some')
  assert.equal(decide(['src/theme.css'], { untraced: ['src/*/*.css'] }).storyIds.length, 3)
  // "**" does cross directories.
  assert.equal(decide(['src/theme.css'], { untraced: ['src/**'] }).storyIds.length, 0)
})

test('an index that does not say where a story came from is a full run', () => {
  // Older Storybooks publish no importPath. Guessing would produce a small,
  // confident, wrong set of stories.
  const decision = decideAffected({
    graph: graph(),
    stories: [...STORIES, { id: 'old--one', title: 'Old', name: 'One', type: 'story', tags: [], importPath: '' }],
    changed: ['src/Button.jsx'],
  })

  assert.equal(decision.run, 'all')
  assert.match(decision.reason, /does not say which file/)
})

test('a stats file that is not one is refused rather than read as an empty graph', () => {
  // An empty graph would make every changed file unknown, which happens to bail
  // safely, but the message would blame the developer's file rather than the
  // build.
  assert.throws(() => readImporterGraph({}), StatsError)
  assert.throws(() => readImporterGraph(null), StatsError)
  assert.throws(() => readImporterGraph({ modules: 'lots' }), StatsError)

  // A module graph with a cycle in it terminates.
  const cyclic = readImporterGraph({
    modules: [
      { id: './a.js', reasons: [{ moduleName: './b.js' }] },
      { id: './b.js', reasons: [{ moduleName: './a.js' }] },
    ],
  })

  assert.equal(decideAffected({ graph: cyclic, stories: STORIES, changed: ['a.js'] }).run, 'all')
})

test('git reports committed and uncommitted work, and refuses a base it does not know', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-affected-'))
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

  try {
    run('init', '--quiet', '--initial-branch', 'main')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')

    fs.mkdirSync(path.join(root, 'app/src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'app/src/Button.jsx'), 'export const Button = 1\n')
    fs.writeFileSync(path.join(root, 'server.js'), 'nothing to do with storybook\n')
    run('add', '.')
    run('commit', '--quiet', '-m', 'first')

    const base = run('rev-parse', 'HEAD').trim()

    fs.writeFileSync(path.join(root, 'app/src/Button.jsx'), 'export const Button = 2\n')
    run('commit', '--quiet', '-am', 'second')
    // Not committed. A developer running this locally has not committed yet,
    // and ignoring their edits would tell them their change was fine without
    // ever having looked at it.
    fs.writeFileSync(path.join(root, 'app/src/New.jsx'), 'export const New = 3\n')

    const project = path.join(root, 'app')
    const changed = changedFiles(project, base)

    // Relative to the Storybook project, not to the repository, or they would
    // never match the stats file in a monorepo.
    assert.deepEqual(changed, ['src/Button.jsx', 'src/New.jsx'])

    // A file outside the project keeps its "../" and is handed on rather than
    // dropped: in a monorepo that is usually a package the Storybook imports,
    // and dropping it is the one mistake this feature cannot afford.
    fs.writeFileSync(path.join(root, 'server.js'), 'changed\n')
    assert.ok(changedFiles(project, base).includes('../server.js'))

    assert.throws(() => changedFiles(project, 'no-such-ref'), GitError)
    assert.throws(() => changedFiles(project, 'no-such-ref'), /not a commit this repository knows about/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI refuses a half written pair of flags rather than guessing a base', () => {
  const options = parseCliArgs(['--only-changed', '--since', 'origin/main'])

  assert.equal(options.onlyChanged, true)
  assert.equal(options.since, 'origin/main')

  // Defaulting to "main" would run the wrong set of stories on a repository
  // whose trunk is called something else, and the run would still be green.
  assert.throws(() => parseCliArgs(['--only-changed']), /--since/)
  assert.throws(() => parseCliArgs(['--since', 'origin/main']), /only means something with --only-changed/)
})

test('the config layer keeps only what it understands, and an empty bail list is a real request', () => {
  const { config } = normaliseConfig({
    onlyChanged: { statsFile: ' out/preview-stats.json ', untraced: ['*.md', 7], bailOnChanges: [] },
  })

  assert.deepEqual(config.onlyChanged, {
    statsFile: 'out/preview-stats.json',
    untraced: ['*.md'],
    bailOnChanges: [],
  })

  // Absent is not the same as empty: absent means the defaults, empty means
  // "never bail", which is a thing someone can mean and must not be invented.
  assert.equal('bailOnChanges' in normaliseConfig({ onlyChanged: {} }).config.onlyChanged, false)
  assert.equal(normaliseConfig({}).config.onlyChanged, undefined)
  assert.equal(normaliseConfig({ onlyChanged: 'yes' }).config.onlyChanged, undefined)

  assert.deepEqual(mergeOptions(config, { onlyChanged: { untraced: ['*.txt'] } }).onlyChanged, { untraced: ['*.txt'] })
})
