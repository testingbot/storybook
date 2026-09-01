#!/usr/bin/env node
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

import { approvableStories, approveStory } from './node/run-store.js'
import { resolveCredentials } from './node/credentials.js'
import { resolveDeviceUrl } from './node/device-url.js'
import { ExternalTunnel } from './node/external-tunnel.js'
import { RunError, runOnGrid } from './node/runner.js'
import { ShardError, validateShardRequest } from './node/shard.js'
import { serveStatic } from './node/serve.js'
import { TunnelManager } from './node/tunnel-manager.js'
import { toTunnelError } from './node/tunnel-errors.js'
import type { ShardRequest } from './node/shard.js'
import type { ProjectConfig, RunProgressEvent, RunResult, TunnelProvider } from './node/types.js'

/**
 * The CLI, so the same configuration that runs in the panel also blocks a bad
 * merge. TB-261.
 *
 * There is no second runner and no second config format here. Everything below
 * is argument parsing, a Storybook to point at, and a report; the run itself is
 * the same runOnGrid the addon calls, reading the same .testingbot.json through
 * the same reader. That is the acceptance criterion, and it is also the only
 * way the two can be trusted to agree: a CLI with its own copy of the config
 * merge would drift from the panel within a release or two, and the symptom
 * would be CI passing on a browser the developer never sees.
 */

// The config reader is CJS because Storybook's preset is, and there is one of
// it rather than two.
const require = createRequire(import.meta.url)
const { readConfig, getConfigPath } = require('../src/server/projectConfig.cjs') as {
  readConfig: (options?: unknown) => { config: ProjectConfig; exists: boolean; removed: string[]; error?: string }
  getConfigPath: () => string
}

const USAGE = `
testingbot-storybook - run Storybook stories on real browsers and devices

Usage
  testingbot-storybook [options]

Where the stories come from
  --url <url>            A Storybook that is already being served. Nothing is
                         built or started.
  --static-dir <dir>     Serve an already built Storybook from this directory.
  --build                Run "storybook build" first, then serve the output.
                         Default when neither --url nor --static-dir is given.
  --port <number>        Port for the served Storybook. Default 6006.

What to run
  --include <glob>       Only stories whose id or title matches. Repeatable.
  --exclude <glob>       Skip stories whose id or title matches. Repeatable.
  --device-url <url>     The URL real devices should open. Only needed when this
                         machine's network address is not reachable from one.
  --capture-docs         Also capture hand written MDX docs pages.
  --capture-autodocs     Also capture the docs pages generated from
                         tags: ['autodocs'].

Running only what changed
  --only-changed         Trace the change since --since through the module graph
                         and run only the stories it can reach.
  --since <ref>          The commit or branch to compare against, for example
                         origin/main. Required by --only-changed.
  --stats-file <file>    Where the build wrote preview-stats.json. Defaults to
                         the served directory. Only needed with --url.

Splitting a run across CI machines
  --shard-count <n>      How many machines the stories are spread over.
  --shard-size <n>       How many stories per machine, instead of --shard-count.
  --shard-index <n>      Which shard this machine is, counting from 0.
  --partial              Say this run is not the whole project, without
                         sharding. Implied by the shard options.

Output
  --json                 Write the full result as JSON to stdout.
  --json-file <file>     Write the full result as JSON to a file.
  --quiet                Only print the summary.

Baselines
  --update-baselines     Take this run as the new truth and write every changed
                         screenshot to .testingbot/baselines for committing.

Other
  --tunnel-id <id>       Reuse a tunnel that is already running, rather than
                         starting one. Also read from TB_TUNNEL_ID.
  --help, --version

A sharded run exits 0 when its own stories matched. It says nothing about the
stories the other shards ran, so it is the CI job that collects them, not this
command, that decides whether the project as a whole passed.

Credentials come from TB_KEY and TB_SECRET, .env, or ~/.testingbot.
Browsers, devices and tolerance come from .testingbot.json.

Exit codes
  0  every story matched its baseline
  1  something differed, failed, or was skipped
  2  the run could not start
`.trim()

const EXIT_OK = 0
const EXIT_DIFF = 1
const EXIT_SETUP = 2

type Options = {
  url: string | null
  staticDir: string | null
  build: boolean
  port: number
  include: string[]
  exclude: string[]
  deviceUrl: string | null
  captureDocs: boolean
  captureAutodocs: boolean
  shard: ShardRequest | null
  onlyChanged: boolean
  since: string | null
  statsFile: string | null
  partial: boolean
  json: boolean
  jsonFile: string | null
  quiet: boolean
  updateBaselines: boolean
  tunnelId: string | null
}

class UsageError extends Error {}

/**
 * A flag that is a whole number or absent. Not Number(): Number('') is 0 and
 * Number('two') is NaN, and both would go on to mean shard 0.
 */
function optionalCount (raw: string | undefined, flag: string): number | null {
  if (raw === undefined) return null

  const value = Number(raw)

  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value)) {
    throw new UsageError(`${flag} must be a whole number, not ${JSON.stringify(raw)}.`)
  }

  return value
}

export function parseCliArgs (argv: string[]): Options | 'help' | 'version' {
  let parsed: ReturnType<typeof parseArgs>

  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        url: { type: 'string' },
        'static-dir': { type: 'string' },
        build: { type: 'boolean', default: false },
        port: { type: 'string' },
        include: { type: 'string', multiple: true, default: [] },
        exclude: { type: 'string', multiple: true, default: [] },
        'device-url': { type: 'string' },
        'capture-docs': { type: 'boolean', default: false },
        'capture-autodocs': { type: 'boolean', default: false },
        'only-changed': { type: 'boolean', default: false },
        since: { type: 'string' },
        'stats-file': { type: 'string' },
        'shard-count': { type: 'string' },
        'shard-size': { type: 'string' },
        'shard-index': { type: 'string' },
        partial: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'json-file': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        'update-baselines': { type: 'boolean', default: false },
        'tunnel-id': { type: 'string' },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }

  const values = parsed.values

  if (values.help) return 'help'
  if (values.version) return 'version'

  const url = (values.url as string | undefined) ?? null
  const staticDir = (values['static-dir'] as string | undefined) ?? null

  // These three answer the same question, and answering it twice differently is
  // a mistake worth catching here rather than halfway through a build.
  if (url && staticDir) {
    throw new UsageError('Pass either --url or --static-dir, not both. They both say where the Storybook is.')
  }

  if (url && values.build) {
    throw new UsageError('--build has nothing to do when --url already points at a served Storybook.')
  }

  const port = values.port === undefined ? 6006 : Number(values.port)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--port must be a port number, not ${String(values.port)}.`)
  }

  // A base to compare against is not something to guess at. Defaulting to
  // "main" would quietly run the wrong set of stories on a repository whose
  // trunk is called something else, and the run would still be green.
  if (values['only-changed'] && !values.since) {
    throw new UsageError('--only-changed needs --since to know what "changed" is measured against, for example --since origin/main.')
  }

  if (values.since && !values['only-changed']) {
    throw new UsageError('--since only means something with --only-changed.')
  }

  // Checked here, before a Storybook build takes two minutes to find out that
  // the flags contradict each other. What cannot be checked yet is the index
  // against the story count, and the runner does that.
  const shardCount = optionalCount(values['shard-count'] as string | undefined, '--shard-count')
  const shardSize = optionalCount(values['shard-size'] as string | undefined, '--shard-size')
  const shardIndex = optionalCount(values['shard-index'] as string | undefined, '--shard-index')
  let shard: ShardRequest | null = null

  if (shardCount !== null || shardSize !== null || shardIndex !== null) {
    if (shardIndex === null) {
      throw new UsageError('--shard-index says which shard this machine is. Without it, nothing knows what to run.')
    }

    shard = { index: shardIndex, count: shardCount, size: shardSize }

    try {
      validateShardRequest(shard)
    } catch (error) {
      throw new UsageError(error instanceof ShardError ? error.message : String(error))
    }
  }

  return {
    url,
    staticDir,
    build: !url && !staticDir,
    port,
    include: values.include as string[],
    exclude: values.exclude as string[],
    deviceUrl: (values['device-url'] as string | undefined) ?? null,
    captureDocs: values['capture-docs'] as boolean,
    captureAutodocs: values['capture-autodocs'] as boolean,
    shard,
    onlyChanged: values['only-changed'] as boolean,
    since: (values.since as string | undefined) ?? null,
    statsFile: (values['stats-file'] as string | undefined) ?? null,
    partial: values.partial as boolean,
    json: values.json as boolean,
    jsonFile: (values['json-file'] as string | undefined) ?? null,
    quiet: values.quiet as boolean,
    updateBaselines: values['update-baselines'] as boolean,
    tunnelId: (values['tunnel-id'] as string | undefined) ?? process.env.TB_TUNNEL_ID ?? null,
  }
}

async function buildStorybook (outDir: string, stats: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // --stats-json is what writes preview-stats.json next to the build, which
    // is the module graph --only-changed traces through. Asked for only when
    // it is needed, since it is another file to write on every build.
    const args = ['storybook', 'build', '--output-dir', outDir, '--quiet', ...(stats ? ['--stats-json'] : [])]
    const child = spawn('npx', args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })

    child.on('error', (error) => reject(new Error(`Could not run "storybook build": ${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) return resolve()

      reject(new Error(`"storybook build" exited with ${code}. Fix the build before running visual tests.`))
    })
  })
}

/** The human report. Deliberately short: CI logs are read in a hurry. */
function printSummary (result: RunResult, projectRoot: string, write: (line: string) => void): void {
  const { totals } = result

  write('')

  for (const target of result.targets) {
    const stories = result.stories.filter((story) => story.target === target.key)
    const counts = { new: 0, passed: 0, diff: 0, failed: 0 }

    for (const story of stories) counts[story.outcome] += 1

    const parts = [
      counts.passed ? `${counts.passed} matched` : null,
      counts.new ? `${counts.new} new` : null,
      counts.diff ? `${counts.diff} differed` : null,
      counts.failed ? `${counts.failed} failed` : null,
    ].filter(Boolean)

    write(`  ${target.label}: ${parts.join(', ') || 'nothing to do'}`)

    if (target.sessionId) {
      write(`    https://testingbot.com/members/tests/${target.sessionId}`)
    }
  }

  for (const entry of result.skipped ?? []) {
    write(`  ${entry.label}: skipped. ${entry.reason}`)
  }

  const problems = result.stories.filter((story) => story.outcome === 'diff' || story.outcome === 'failed')

  if (problems.length > 0) {
    write('')

    for (const story of problems) {
      const detail = story.outcome === 'diff'
        ? `${(100 * (story.diffPixelRatio ?? 0)).toFixed(3)}% of pixels differ`
        : story.message ?? 'failed'

      write(`  ${story.storyId} on ${story.target}: ${detail}`)

      if (story.diffPath) {
        write(`    ${path.relative(projectRoot, story.diffPath)}`)
      }
    }
  }

  write('')

  if (totals.new > 0) {
    write(`  ${totals.new} new baseline${totals.new === 1 ? '' : 's'} written. Commit .testingbot/baselines to make them count.`)
  }

  if (result.changeTrace) {
    const { base, changedFiles, reason, tracedTo } = result.changeTrace

    write(`  ${changedFiles} file${changedFiles === 1 ? '' : 's'} changed since ${base}. ${reason}`)

    if (tracedTo === null) {
      write('  Tracing did not narrow this run: every story ran.')
    }
  }

  if (result.shard) {
    const { index, count, selected, total } = result.shard

    write(`  Shard ${index} of ${count}, counting from 0: ${selected} of the project's ${total} stories.`)
  }

  // "Everything matched" is a claim, and a run that captured nothing has not
  // earned it. This happens to a shard with more shards than stories.
  const verdict = result.stories.length === 0
    ? '  Nothing was captured, so there is nothing to say about this run.'
    : '  Everything matched.'

  write(result.ok
    ? verdict
    : '  This run did not match. Review the diffs, then either fix the change or re-run with --update-baselines.')

  if (result.partial && result.ok && result.stories.length > 0) {
    // Said in the shard's own log because that is where someone reads it, and
    // because "Everything matched" on its own invites the wrong conclusion.
    write('  This run was only part of the project. The other parts have to agree before the project has passed.')
  }

  write('')
}

async function main (argv: string[]): Promise<number> {
  let options: Options | 'help' | 'version'

  try {
    options = parseCliArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\nRun testingbot-storybook --help.\n`)

    return EXIT_SETUP
  }

  if (options === 'help') {
    process.stdout.write(`${USAGE}\n`)

    return EXIT_OK
  }

  if (options === 'version') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

    process.stdout.write(`${pkg.version}\n`)

    return EXIT_OK
  }

  const projectRoot = process.cwd()
  const log = (line: string) => process.stderr.write(`${line}\n`)
  const verbose = (line: string) => { if (!options.quiet) log(line) }

  const credentials = resolveCredentials()

  if (!credentials) {
    log('No TestingBot credentials. Set TB_KEY and TB_SECRET, or put them in .env or ~/.testingbot.')
    log('You can find them at https://testingbot.com/members/user/edit')

    return EXIT_SETUP
  }

  const { config, exists, error: configError } = readConfig()

  if (configError) {
    log(configError)

    return EXIT_SETUP
  }

  if (!exists) {
    verbose(`No ${path.basename(getConfigPath())}, using the default single browser.`)
  }

  // CLI flags narrow what the config already asked for rather than replacing
  // it, so a run scoped to one component still uses the project's browsers.
  const effective: ProjectConfig = {
    ...config,
    ...(options.include.length ? { include: options.include } : {}),
    ...(options.exclude.length ? { exclude: options.exclude } : {}),
    // One way only. A flag can turn docs capture on for a run; it cannot turn
    // off what the project committed, because its absence is not a request.
    ...(options.captureDocs ? { captureDocs: true } : {}),
    ...(options.captureAutodocs ? { captureAutodocs: true } : {}),
  }

  let server: Awaited<ReturnType<typeof serveStatic>> | null = null
  let devServerUrl: string
  const configuredStats = typeof config.onlyChanged?.statsFile === 'string' ? config.onlyChanged.statsFile : null
  let statsFile: string | null = options.statsFile
    ? path.resolve(options.statsFile)
    : configuredStats
      ? path.resolve(projectRoot, configuredStats)
      : null
  let deviceUrl = options.deviceUrl ?? (typeof config.deviceUrl === 'string' ? config.deviceUrl : null)

  try {
    if (options.url) {
      devServerUrl = options.url.replace(/\/$/, '')

      // Nothing was built here, so there is no directory to find the stats in.
      // Falling through with tracing quietly switched off would run the whole
      // project and bill for it without ever saying why.
      if (options.onlyChanged && !statsFile) {
        throw new Error(
          '--only-changed needs --stats-file when the Storybook is already being served, ' +
          'because there is no build directory to find preview-stats.json in.',
        )
      }
    } else {
      const dir = options.staticDir ?? path.join(projectRoot, 'storybook-static')

      // The build writes its stats next to itself, so the default needs no
      // configuration in the case that matters, which is CI running --build.
      statsFile ??= path.join(path.resolve(dir), 'preview-stats.json')

      if (options.build) {
        verbose('Building Storybook...')
        await buildStorybook(dir, options.onlyChanged)
      }

      server = await serveStatic(dir, options.port)
      devServerUrl = server.url

      // A served build is on this machine's network address too, which is what
      // a real device can open. See device-url.ts for why localhost is not.
      if (!deviceUrl && effective.devices.length > 0) {
        const reachable = resolveDeviceUrl({ networkAddress: server.networkUrl })

        deviceUrl = reachable.reachable ? reachable.url : null

        if (!reachable.reachable) log(reachable.reason)
      }
    }
  } catch (error) {
    log((error as Error).message)

    return EXIT_SETUP
  }

  const tunnel: TunnelProvider = options.tunnelId
    ? new ExternalTunnel(options.tunnelId)
    : new TunnelManager({ credentials, logger: { info: verbose, warn: log, error: log } })

  if (options.tunnelId) verbose(`Using the tunnel already running as ${options.tunnelId}.`)

  const controller = new AbortController()
  const onSignal = () => controller.abort()

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  let result: RunResult

  try {
    result = await runOnGrid({
      credentials,
      config: effective,
      devServerUrl,
      deviceUrl,
      shard: options.shard,
      changes: options.onlyChanged && options.since && statsFile
        ? { base: options.since, statsFile }
        : null,
      partial: options.partial,
      signal: controller.signal,
      projectRoot,
      tunnelManager: tunnel,
      onProgress: (event: RunProgressEvent) => {
        if (options.quiet) return

        if (event.phase === 'stories') {
          const where = options.shard ? ` in shard ${options.shard.index}` : ''

          log(`${event.total} stor${event.total === 1 ? 'y' : 'ies'} to run${where}.`)
        }
        if (event.phase === 'tunnel') log(event.message)
        if (event.phase === 'notice') log(`  ${event.message}`)
        if (event.phase === 'target-started') log(`${event.label}: starting...`)
        if (event.phase === 'target-finished') log(`${event.label}: done.`)
      },
    })
  } catch (error) {
    // A RunError already says what failed and on which target. Passing it
    // through toTunnelError relabels it, so a dead grid session used to be
    // reported as "TestingBot Tunnel could not be started".
    log(error instanceof RunError ? error.message : toTunnelError(error).message)

    if (error instanceof RunError && error.code === 'NO_DEVICE_URL') {
      log('Pass --device-url with a Storybook a device can open.')
    }

    return EXIT_SETUP
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)

    // Only the tunnel we started, and only after the run. ExternalTunnel.stop
    // is a no-op for exactly this reason.
    await tunnel.stop()
    await server?.close()
  }

  if (options.updateBaselines) {
    const promoted = approvableStories(result)

    for (const story of promoted) {
      approveStory(projectRoot, story.storyId, story.target)
    }

    verbose(`${promoted.length} baseline${promoted.length === 1 ? '' : 's'} updated from this run.`)
    verbose('Commit .testingbot/baselines. Nothing else made these the new truth.')

    // Every difference was just accepted, so there is nothing left to fail on.
    // A non-zero exit here would make the regeneration workflow red by design.
    return result.totals.failed > 0 ? EXIT_DIFF : EXIT_OK
  }

  if (options.json || options.jsonFile) {
    // Always to stdout or a file, never mixed into the log. Everything the
    // human report writes goes to stderr precisely so that
    // `testingbot-storybook --json | jq` works.
    const json = `${JSON.stringify(result, null, 2)}\n`

    if (options.jsonFile) {
      fs.mkdirSync(path.dirname(path.resolve(options.jsonFile)), { recursive: true })
      fs.writeFileSync(options.jsonFile, json)
      verbose(`Wrote ${options.jsonFile}`)
    }

    if (options.json) process.stdout.write(json)
  }

  if (!options.quiet || !result.ok) {
    printSummary(result, projectRoot, log)
  }

  return result.ok ? EXIT_OK : EXIT_DIFF
}

/**
 * Whether this file was run as a command rather than imported.
 *
 * Both sides have to be resolved before they can be compared. npm installs a
 * bin as a symlink in node_modules/.bin, so argv[1] is that symlink while
 * import.meta.url is the real path of dist/cli.js, and comparing the two
 * unresolved makes every installed copy of this CLI exit 0 having done
 * nothing at all. pathToFileURL rather than string concatenation because a
 * path can contain a space or a "#", and "file://" + that is not a valid URL.
 */
function isEntryPoint (): boolean {
  const invoked = process.argv[1]

  if (invoked === undefined) return false

  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(invoked)).href
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error: Error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`)
      process.exitCode = EXIT_SETUP
    },
  )
}

export { main }
