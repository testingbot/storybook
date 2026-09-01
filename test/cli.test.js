import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ExternalTunnel, serveStatic } from '../dist/index.js'
import { parseCliArgs } from '../dist/cli.js'

/**
 * TB-261. The CLI is argument parsing, somewhere to point, and a report; the
 * run itself is the same runOnGrid the panel calls, so what is worth testing
 * here is the parts the panel does not have.
 */

test('the default is build and serve, and --url turns both off', () => {
  const fresh = parseCliArgs([])

  assert.equal(fresh.build, true)
  assert.equal(fresh.url, null)
  assert.equal(fresh.port, 6006)

  const served = parseCliArgs(['--url', 'http://localhost:9009/'])

  assert.equal(served.build, false)
  assert.equal(served.url, 'http://localhost:9009/')

  // A prebuilt directory is served but not rebuilt.
  const prebuilt = parseCliArgs(['--static-dir', 'storybook-static'])

  assert.equal(prebuilt.build, false)
  assert.equal(prebuilt.staticDir, 'storybook-static')
})

test('two answers to "where is the Storybook" is an error, not a silent winner', () => {
  assert.throws(() => parseCliArgs(['--url', 'http://a', '--static-dir', 'b']), /not both/)
  assert.throws(() => parseCliArgs(['--url', 'http://a', '--build']), /nothing to do/)
})

test('a port that is not a port is rejected before anything is built', () => {
  assert.throws(() => parseCliArgs(['--port', 'abc']), /port number/)
  assert.throws(() => parseCliArgs(['--port', '0']), /port number/)
  assert.throws(() => parseCliArgs(['--port', '70000']), /port number/)
  assert.equal(parseCliArgs(['--port', '9009']).port, 9009)
})

test('include and exclude are repeatable, because one glob is rarely enough', () => {
  const options = parseCliArgs(['--include', 'Button/*', '--include', 'Badge/*', '--exclude', '*--skip'])

  assert.deepEqual(options.include, ['Button/*', 'Badge/*'])
  assert.deepEqual(options.exclude, ['*--skip'])
})

test('an unknown flag stops the run rather than being ignored', () => {
  // Ignoring it would mean --updatebaselines silently does nothing and CI stays
  // red for a reason nobody can see.
  assert.throws(() => parseCliArgs(['--updatebaselines']))
})

test('the tunnel id falls back to the environment the action sets', () => {
  const before = process.env.TB_TUNNEL_ID

  try {
    process.env.TB_TUNNEL_ID = 'gh-actions-42'
    assert.equal(parseCliArgs([]).tunnelId, 'gh-actions-42')
    // An explicit flag still wins.
    assert.equal(parseCliArgs(['--tunnel-id', 'mine']).tunnelId, 'mine')
  } finally {
    if (before === undefined) delete process.env.TB_TUNNEL_ID
    else process.env.TB_TUNNEL_ID = before
  }
})

test('--json and --json-file are separate, so piping to jq is not corrupted by a log line', () => {
  assert.equal(parseCliArgs(['--json']).json, true)
  assert.equal(parseCliArgs(['--json']).jsonFile, null)
  assert.equal(parseCliArgs(['--json-file', 'out.json']).json, false)
  assert.equal(parseCliArgs(['--json-file', 'out.json']).jsonFile, 'out.json')
})

test('a tunnel started elsewhere is used and never stopped', async () => {
  // Stopping it would break every later step of the CI job, and starting a
  // second one would spend another parallel session from the plan.
  const tunnel = new ExternalTunnel('gh-actions-42')

  const info = await tunnel.ensureStarted('http://localhost:6006', { alsoProxy: ['http://192.168.1.24:7007'] })

  assert.equal(info.tunnelIdentifier, 'gh-actions-42')
  assert.equal(info.capability.tunnelIdentifier, 'gh-actions-42')
  assert.deepEqual(info.capability.localHttpPorts, [6006, 7007])

  // A no-op, and it must not throw either.
  await tunnel.stop()
})

/** The build-and-serve half. */

function tempStorybook (files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-storybook-'))

  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }

  return dir
}

test('a directory that is not a built Storybook is refused with the reason', async () => {
  const dir = tempStorybook({ 'readme.txt': 'nothing here' })

  await assert.rejects(serveStatic(dir, 0), /index\.json/)
})

test('the served build answers the index the runner asks for', async () => {
  const dir = tempStorybook({
    'index.json': JSON.stringify({ v: 5, entries: {} }),
    'iframe.html': '<!doctype html><title>story</title>',
  })

  const server = await serveStatic(dir, 0)

  try {
    // Port 0 means the OS picks one, and the reported URL has to be the port
    // it actually bound. Pointing the runner at :0 would fail every story.
    const port = Number(new URL(server.url).port)

    assert.ok(port > 0)

    const index = await fetch(`http://127.0.0.1:${port}/index.json`)

    assert.equal(index.status, 200)
    assert.deepEqual(await index.json(), { v: 5, entries: {} })

    // Directory requests fall through to index.html, which is what a browser
    // opening the served Storybook asks for.
    assert.equal((await fetch(`http://127.0.0.1:${port}/iframe.html`)).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404)
  } finally {
    await server.close()
  }
})

test('a request cannot escape the build directory', async () => {
  const dir = tempStorybook({
    'index.json': JSON.stringify({ v: 5, entries: {} }),
  })

  fs.writeFileSync(path.join(dir, '..', 'tb-secret.txt'), 'not yours')

  const server = await serveStatic(dir, 6017)

  try {
    // Both the raw and the encoded form, because decoding happens before the
    // containment check and only one of these would be caught otherwise.
    for (const attempt of ['/../tb-secret.txt', '/..%2ftb-secret.txt', '/%2e%2e/tb-secret.txt']) {
      const response = await fetch(`http://127.0.0.1:6017${attempt}`)

      assert.notEqual(response.status, 200, attempt)
      assert.doesNotMatch(await response.text(), /not yours/, attempt)
    }

    // And a file that is inside it is served.
    assert.equal((await fetch('http://127.0.0.1:6017/index.json')).status, 200)
  } finally {
    await server.close()
    fs.rmSync(path.join(dir, '..', 'tb-secret.txt'), { force: true })
  }
})

/**
 * A run that fails inside the run must not be reported as a tunnel failure.
 * toTunnelError has a fallback that names the tunnel for anything it does not
 * recognise, so routing a RunError through it turned "no stories matched" into
 * "TestingBot Tunnel could not be started" and sent people to fix Java.
 */
test('a failure inside the run keeps its own message instead of blaming the tunnel', async () => {
  const { main } = await import('../dist/cli.js')

  const cwd = process.cwd()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-'))
  const written = []
  const stderr = process.stderr.write
  const { TB_KEY, TB_SECRET } = process.env
  const fetchOriginal = globalThis.fetch

  process.chdir(dir)
  process.env.TB_KEY = 'k'
  process.env.TB_SECRET = 's'
  process.stderr.write = (line) => { written.push(String(line)); return true }
  globalThis.fetch = async () => new Response(JSON.stringify({ v: 5, entries: {} }), {
    headers: { 'content-type': 'application/json' },
  })

  let code
  try {
    // --tunnel-id keeps a real tunnel out of it: an external tunnel is adopted,
    // never started, and never stopped.
    code = await main(['--url', 'http://localhost:6006', '--tunnel-id', 'someone-elses'])
  } finally {
    globalThis.fetch = fetchOriginal
    process.stderr.write = stderr
    process.chdir(cwd)
    if (TB_KEY === undefined) delete process.env.TB_KEY; else process.env.TB_KEY = TB_KEY
    if (TB_SECRET === undefined) delete process.env.TB_SECRET; else process.env.TB_SECRET = TB_SECRET
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const output = written.join('')

  // EXIT_SETUP: this is something to fix before running again, not a red run.
  assert.equal(code, 2)
  assert.match(output, /stor/i)
  assert.doesNotMatch(output, /Tunnel could not be started/)
})

test('the command still runs when it is reached through a symlink', async () => {
  // npm installs a bin as a symlink in node_modules/.bin, so argv[1] is the
  // symlink and import.meta.url is the real path of dist/cli.js. Comparing
  // those unresolved makes the CLI exit 0 having printed nothing and done
  // nothing, on every machine that installed it rather than ran it from a
  // checkout, which is the worst possible place for a silent no-op.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bin-'))
  const link = path.join(scratch, 'testingbot-storybook')

  try {
    fs.symlinkSync(new URL('../dist/cli.js', import.meta.url).pathname, link)

    const { execFileSync } = await import('node:child_process')
    const stdout = execFileSync(process.execPath, [link, '--version'], { encoding: 'utf8' })

    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
