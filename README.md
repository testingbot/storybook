# @testingbot/storybook

Run your Storybook stories against real browsers and real devices in the
[TestingBot](https://testingbot.com) cloud, from inside Storybook.

Pick browsers and real devices in the panel, run your stories on them, and
review the pixel differences without leaving Storybook. Results also appear in
Storybook's own Testing widget and as status icons in the sidebar.

## Install

```sh
npm install --save-dev @testingbot/storybook
```

Add it to `.storybook/main.js`:

```js
export default {
  addons: ['@testingbot/storybook'],
}
```

Set your credentials, from https://testingbot.com/members/user/edit:

```sh
export TB_KEY=...
export TB_SECRET=...
```

You can also enter them in the addon panel. Resolution order, most specific
first:

1. `TB_KEY` and `TB_SECRET` in the environment
2. `TB_KEY` and `TB_SECRET` in the project's `.env`
3. `~/.testingbot` (`key:secret` on one line), shared with the rest of the
   TestingBot toolchain
4. Credentials entered in the panel for this session only

A pair is always taken from a single source. Mixing a key from one place with a
secret from another only produces a confusing 401, so partial sources are
skipped.

## Configuration

Two places, and you can use either or both.

**`.testingbot.json` in your project root.** Committable, reviewable, and the
file the CLI reads, so this is the one to use if you run in CI as well.

```json
{
  "browsers": [
    { "browserName": "chrome", "browserVersion": "latest", "platform": "WIN10" }
  ],
  "devices": [],
  "include": [],
  "exclude": [],
  "maxDiffPixelRatio": 0.001
}
```

**Addon options in `.storybook/main.js`.** Storybook's own convention, and these
override the file:

```js
export default {
  addons: [
    {
      name: '@testingbot/storybook',
      options: { maxDiffPixelRatio: 0.05 },
    },
  ],
}
```

### Per-story settings

Some things belong to one story rather than to the project. Those go in
Storybook's own `parameters`, under a `testingbot` key, so they live next to the
story and move with it when it is renamed:

```js
export const Loading = {
  parameters: {
    testingbot: {
      // Never screenshot this one.
      skip: true,
      // Wait for this before screenshotting, on top of the usual settle wait.
      waitForSelector: '[data-testid="loaded"]',
      // How long that may take, in milliseconds. Default 15000.
      waitTimeout: 30000,
      // Render with these args instead of the story's own.
      args: { variant: 'danger' },
      // Switch a Storybook global, which is usually theme or locale.
      globals: { theme: 'dark' },
      // Extra query string parameters, for a story whose app reads them.
      queryParams: { token: 'preview' },
    },
  },
}
```

They work the same on desktop browsers, real Android and real iPhones.

A few things are worth knowing. `skip` is reported rather than silent, because a
run that quietly covered one story fewer would still say everything matched.

`args` and `globals` are encoded exactly as Storybook's own toolbar encodes
them, which means Storybook's restrictions apply: a value it would refuse to put
in a URL is left out and named, and the story renders with its default.

A global has to be one your Storybook declares, in `initialGlobals` or
`globalTypes` in `.storybook/preview.js`. Storybook drops an undeclared global
and says so only in the browser's own console, so the addon checks the names
itself and tells you which one was ignored.

`queryParams` are ordinary query string parameters, encoded normally, for a
story whose app reads `window.location.search` rather than going through
Storybook. `id`, `viewMode`, `args` and `globals` are refused there, because the
addon sets them and a second `id` would screenshot a different story under this
story's name.

None of them change the baseline name, because a story that always renders the
same way always renders the same way.

### Capturing one story several ways

To screenshot the same component in more than one state, export it more than
once. Each export is its own story, so it gets its own baseline with no naming
scheme to learn, and `tags: ['!dev']` keeps a capture-only variant out of the
Storybook sidebar while leaving it in the index the addon reads:

```js
export const Default = {}

export const Dark = {
  tags: ['!dev'],
  parameters: { testingbot: { globals: { theme: 'dark' } } },
}
```

This is what @percy/storybook's `additionalSnapshots` is for. Storybook already
has the mechanism, so the addon does not add a second one.

Storybook does not publish parameters in `/index.json`, so they can only be read
from a loaded preview. Each target reads them once, from the grid browser, which
costs one extra page load per target. A Storybook that does not expose a store
the addon understands runs without per-story settings and says so once.

### Docs pages

Storybook has two kinds of page, and by default the addon runs only one of them.
Stories are captured; docs pages are not, unless you say so:

```json
{
  "captureDocs": true,
  "captureAutodocs": true
}
```

`captureDocs` covers the MDX pages you wrote by hand. `captureAutodocs` covers
the pages Storybook generates for a component tagged `autodocs`. They are two
settings because they are two decisions: a hand written page is usually the only
thing covering itself, while a generated one is mostly a composition of stories
that are already captured one by one, and every page is a grid session.

`--capture-docs` and `--capture-autodocs` turn them on for a single CLI run. The
flags only turn capture on: their absence is not a request to override a project
that committed `true`.

Two things follow from a docs page being a different page rather than a
different story:

- It is captured as the whole docs container, not cropped to a component, and
  that container is at least as tall as the viewport. A short docs page is
  therefore mostly empty space, and `maxDiffPixelRatio` is a fraction of all of
  it. This is the opposite of the story case above, so a docs page catches
  layout regressions in the docs template rather than small changes inside one
  component.
- It has no `parameters.testingbot` of its own, because Storybook does not
  publish parameters for docs entries. Use `exclude` to leave one out. The one
  exception is `skip` on a component whose every story is skipped: its generated
  docs page is skipped with them, since the meta that skipped them is the meta
  that generated it.

Naming a docs page by id runs it whether or not these settings are on, because
asking for one page by id is an explicit request for it.

### Extra capabilities

Any [TestingBot option](https://testingbot.com/support/web-automate/playwright/options)
you add to a browser entry is passed through to the session, so you can set
things this addon has no opinion about:

```json
{
  "browsers": [
    {
      "browserName": "chrome",
      "browserVersion": "latest",
      "platform": "WIN10",
      "timeZone": "Europe/Brussels",
      "geoCountryCode": "BE",
      "screenResolution": "1920x1080",
      "build": "storybook-main"
    }
  ]
}
```

`timeZone` and `geoCountryCode` are worth knowing about for visual testing:
they change how dates, times and currency render, which is exactly the kind of
difference a screenshot diff will catch.

Five capabilities are reserved, because the addon computes them and setting them
by hand would either break the run or point it at another account: `key`,
`secret`, `tunnelIdentifier`, `localHttpPorts` and `localHttpsPorts`. If you set
one, it is ignored and the panel tells you.

Keys the addon does not recognise are preserved, not dropped, so saving from the
panel will not delete something you put in the file by hand.

## Why this addon needs a tunnel

A browser in the TestingBot cloud that opens `http://localhost:6006` resolves
that inside the cloud VM, where nothing is listening. Your stories have to be
reachable from the grid, so the addon starts and manages a
[TestingBot Tunnel](https://testingbot.com/support/tunnel) for you.

There is a second, less obvious problem. The tunnel proxies a fixed set of ports
into the cloud VM without being asked: 80, 443, 3000, 3001, 3030, 3400 and 8080.
Storybook's default port, 6006, is not one of them, so a healthy tunnel on its
own is still not enough. The addon derives your dev server's actual port and
requests it through the `localHttpPorts` capability, which is why you do not
have to think about any of this.

Requirements for the tunnel:

- **Java 11 or newer** on your PATH. TestingBot Tunnel is a Java program.
- A free tunnel slot on your account.

The tunnel is started lazily, on your first run rather than on `storybook dev`,
so sessions that never run a test do not consume a tunnel. It is torn down when
Storybook exits, including on Ctrl+C.

## Screenshots and baselines

The first run for a browser has nothing to compare against, so every story is
recorded as **new** and its screenshot becomes the baseline. Every run after
that compares against it.

```
.testingbot/
  baselines/<browser-key>/<story-id>.png   commit this
  results/<browser-key>/<story-id>.png     do not commit
  results/<browser-key>/<story-id>.diff.png
```

Baselines are the reviewable artefact: they belong in git, so a visual change
shows up in a pull request. Results are per-run output and should be ignored:

```
.testingbot/results/
```

### What gets screenshotted

The story element (`#storybook-root`), not the whole page. Docs pages are the
exception and are covered below. This matters more
than it sounds. A tolerance is a fraction of the image, so a full page
screenshot makes the denominator mostly empty space around your component. At
1280x720 a 2% tolerance is 18,432 pixels, which is larger than most components,
and a change that visibly alters every button on the page still scores under
it. Cropping to the story makes the denominator the thing under test.

If a story renders into a portal outside the story root, such as a modal
attached to `document.body`, set `"fullPage": true` to opt back out.

### Tolerance

`maxDiffPixelRatio` defaults to `0.001`: a story fails when more than 0.1% of
its pixels differ. That is deliberately tight, and it is tight because it can
afford to be. Measured against the grid, two consecutive runs of 15 stories on
two browsers produced zero differing pixels in all 30 comparisons, so the
budget is not absorbing run-to-run noise. It exists for browser version drift.

Before comparing, the addon waits for the story to stop changing: it polls the
story root until its size and markup have been stable for 500ms, capped at 15
seconds. Without this, play functions that are still mutating the DOM produce
screenshots at different heights between runs.

A height change is reported as a size mismatch rather than as "100% of pixels
differ", because "the story got taller" is the useful message.

### Viewport

Defaults to 1280x720. Set it per project:

```json
{ "viewport": { "width": 1440, "height": 900 } }
```

### Several widths in one run

To catch a layout that only breaks on a phone-sized screen, list the widths you
care about:

```json
{ "widths": [375, 768, 1280] }
```

Every story is then captured once per width in the same grid session, and each
width gets its own baseline folder: `chrome_latest_win11_375` next to
`chrome_latest_win11_1280`. The height comes from `viewport`, or 720 if you have
not set one.

Two things are worth knowing before you turn this on.

The first is cost. Widths multiply the whole run, so three widths across five
browsers is fifteen times the stories. The panel shows the multiplier before you
press Run.

The second is that this is a desktop setting. A real iPhone has the screen it
has, and forcing it to 1280 would render a desktop-shaped page on a phone, which
is the opposite of why you ran it on a phone. Devices are captured at their own
size, keep their existing baseline key, and the run says so rather than letting
you assume otherwise.

If you leave `widths` out, nothing changes: one capture at `viewport`, and the
baseline folders keep the names they already have.

### Where the comparison happens

By default the addon compares locally: it downloads the screenshot, diffs it
against the PNG in `.testingbot/baselines/`, and writes a diff image next to it.
Baselines are files in your repository, so a change to one shows up in a pull
request like any other change.

You can instead hand the whole job to TestingBot:

```json
{
  "devices": [
    { "deviceName": "iPhone 15", "platformName": "iOS", "platformVersion": "18.0" }
  ],
  "visual": "hosted"
}
```

In hosted mode nothing is downloaded and no PNG is written. The grid takes the
screenshot, compares it, and returns the verdict, and the panel links to the
comparison on TestingBot instead of showing a local diff.

It applies to every target in the run, browsers and devices alike, but devices
are what it is for. A device
screenshot depends on the exact handset the grid allocated, which makes a PNG
committed to a repository a fragile baseline in a way a desktop Chrome one is
not. The hosted service keys baselines per test environment and ignores the iOS
and Android status and navigation bars automatically, which is a class of false
positive the local path would otherwise leave to you.

Two things to know before turning it on:

- Baselines live on TestingBot, not in your repository. They will not appear in
  a pull request, and reviewing a change means opening the link.
- `maxDiffPixelRatio` does not apply. The hosted service reports a count of
  differing pixels rather than a fraction, and returns no image dimensions to
  divide by, so the two are not interchangeable. Use `threshold` instead.

Desktop browsers work in hosted mode too, though `local` remains the default
for them. Keeping browser baselines in the repository means a change shows up
in the pull request, which is usually what you want when the baseline is stable
enough to commit.

Options are passed to the service under `hostedVisual`:

```json
{
  "visual": "hosted",
  "hostedVisual": {
    "threshold": 0.3,
    "ignoreSelectors": [".live-clock"]
  }
}
```

`threshold`, `ignoreRegions`, `ignoreSelectors`, `diffColor`, `antialiasing` and
`disableFreeze` are forwarded. Anything else is dropped, because the service
would drop it anyway and a command should not claim to ask for something it does
not.

## Using the panel

Open the **TestingBot** tab in the addon panel, or the TestingBot button in the
toolbar.

**Pick your browsers.** The panel lists what your account can actually run,
fetched from TestingBot rather than hardcoded, so the versions offered are the
ones that exist today. Add a browser, choose a version, and it is written to
`.testingbot.json`.

**Choose what to run.** Three scopes:

| Scope | Runs |
| --- | --- |
| This story | The story you are looking at |
| This component | Every story in the current component |
| All stories | Everything the `include` and `exclude` globs allow |

Start with a single story. A full run is one grid session per browser and it is
billed by the minute, so the narrow scopes are there to keep the feedback loop
cheap.

**Watch it run.** Progress is per story and per target, including the tunnel
coming up, so a slow run tells you which part is slow. **Cancel** stops the run
and closes the sessions rather than leaving them to time out on your account.

**Review the differences.** Changed stories show baseline and current side by
side, with a toggle for an overlay of the differing pixels. If the change is
what you intended, **Approve this change** promotes the current screenshot to
the baseline, and the next run compares against it. Approving writes to
`.testingbot/baselines`, so the approval itself is a diff in your next commit
and is reviewable like any other change.

## Real devices

Real iPhones and Android devices are in the same picker as the browsers, and
they take two different code paths. Playwright can drive Chrome on a real
Android device, so Android targets connect the same way a desktop browser does
and inherit all of its behaviour. Playwright has no iOS backend at all, so a
physical iPhone is driven over WebDriver and Mobile Safari instead. Everything
after the screenshot is the same on both paths.

### Simulators, emulators and physical hardware

The picker lists all three, and the ones that are not physical hardware say so
in their label. They start faster and cost less, which makes them useful while
iterating, but they render on a desktop GPU and will not catch what a phone
catches.

A device entry carries `realDevice`, which defaults to `true`:

```json
{
  "devices": [
    { "deviceName": "iPhone 15", "platformName": "iOS", "platformVersion": "18.0" },
    {
      "deviceName": "iPhone 15",
      "platformName": "iOS",
      "platformVersion": "18.0",
      "realDevice": false
    }
  ]
}
```

Those are two targets, not one written twice. They render differently, so they
get separate baselines: the physical one is keyed `iphone-15_ios_18.0` and the
simulator `iphone-15_ios_18.0_simulator`. Baselines written before simulators
were selectable keep their keys.

This distinction is not cosmetic. TestingBot exposes two inventories, and they
do not describe the same fleet. `https://api.testingbot.com/v1/browsers` lists
iOS simulators and Android emulators, plus physical Android marked
`REAL_ANDROID`; an iOS entry there reports the macOS version hosting it rather
than an iOS version. Physical iOS appears only in
`https://api.testingbot.com/v1/devices`, which is the fleet inventory and says
whether each device is free right now. The addon reads both, and only offers
hardware that is actually available.

There is one constraint the panel handles for you and that is worth
understanding, because it is the reason a device target can appear disabled: a
real device cannot resolve the hostname `localhost` at all. The tunnel does not
change that. So devices are not given Storybook's `localhost` URL. They are
given Storybook's network address, `http://<your LAN IP>:<port>/`, which needs
no name resolution and which Storybook already binds to and allowlists.

Two situations have no such address, and in both the device targets are shown
disabled with the reason rather than silently skipped:

- The machine has no non-internal IPv4 address.
- Storybook was started with `--host localhost`, which binds to the loopback
  interface only.

The escape hatch for both, and for a Storybook you have published somewhere, is
`deviceUrl` in `.testingbot.json` or `--device-url` on the CLI.

## Running in CI

The same runner, without Storybook's dev server:

```sh
npx testingbot-storybook
```

By default it runs `storybook build`, serves the output, and runs your
configured browsers against it. Point it at something already running with
`--url`, or at an already built directory with `--static-dir`.

```yaml
- run: npx testingbot-storybook --json-file tb-results.json
  env:
    TB_KEY: ${{ secrets.TB_KEY }}
    TB_SECRET: ${{ secrets.TB_SECRET }}
```

Exit codes are the point of the CLI:

| Code | Meaning |
| --- | --- |
| 0 | Every story matched its baseline |
| 1 | Something differed, failed, or was skipped |
| 2 | The run could not start at all |

A skipped target counts as a failure. A run that quietly covered fewer browsers
than you asked for would otherwise report green for browsers nobody tested.

If your CI already starts a tunnel, for example with
[testingbot-tunnel-action](https://github.com/testingbot/testingbot-tunnel-action),
pass `--tunnel-id` or set `TB_TUNNEL_ID` and the CLI will reuse it instead of
starting a second one and consuming another parallel session.

`--update-baselines` takes the run as the new truth and rewrites every changed
baseline, which is the "the redesign landed, accept all of it" button. Run it
deliberately, not on every build.

`testingbot-storybook --help` lists the rest.

### Splitting a run across machines

A few hundred stories on one machine takes as long as it takes. `--shard-count`
and `--shard-index` spread them over several:

```yaml
jobs:
  visual:
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - run: npx testingbot-storybook --shard-count 4 --shard-index ${{ matrix.shard }}
        env:
          TB_KEY: ${{ secrets.TB_KEY }}
          TB_SECRET: ${{ secrets.TB_SECRET }}
```

`--shard-index` counts from 0, as Percy's does. `--shard-size` says how many
stories per machine instead of how many machines, and the count is derived from
it; passing both is an error, because they both answer the same question.

Each shard sorts the stories by id and takes its own contiguous block, so the
machines need to agree on nothing but the commit they built. Blocks differ in
size by at most one story. An index past the last shard is an error rather than
an empty run: it means the matrix and the flags disagree, and the stories that
index would have covered would otherwise be captured by nobody while every job
stayed green. More shards than stories is allowed, and the shards that draw
nothing say so and exit 0 without opening a grid session.

Two things to know before using it.

A shard exits 0 when **its own** stories matched. It cannot say anything about
the stories the other shards ran, so it is the job that collects the matrix, not
this command, that decides whether the project passed. The JSON result carries
`"partial": true` and a `shard` object for exactly this reason. `--partial` sets
the same flag without sharding, for a run you already know is a subset.

Every shard opens its own grid sessions, so four shards want four times the
account concurrency at once. If your account limit is the bottleneck rather than
wall clock, sharding will not help and may queue.

Give each shard its own checkout. They read the same committed baselines, which
is fine, but `--update-baselines` and `.testingbot/last-run.json` are per
machine, so a shared working directory would have them overwrite each other.

### Running only the stories a change can reach

Sharding makes a full run faster. `--only-changed` makes most runs smaller:

```bash
npx testingbot-storybook --only-changed --since origin/main
```

The addon builds Storybook with `--stats-json`, reads the module graph the build
writes out, and walks up from every file git says you changed to the stories
that import it, directly or through any number of hops. A change to a shared
button reaches every story that renders one. A change to one story file reaches
only that file's stories.

`--since` is required and has no default. Guessing `main` on a repository whose
trunk is called something else would run the wrong set of stories and still go
green. The comparison is `base...HEAD`, so it is against the merge base rather
than against whatever else has landed on the base branch. Uncommitted and
untracked work counts as changed, because locally you have not committed yet and
a tool that ignored your edits would tell you your change was fine without
having looked at it.

The interesting part is what makes it give up and run everything, and it says so
every time:

| Situation | What happens |
| --- | --- |
| A changed file the module graph has never heard of | Full run, naming the file |
| A changed file that reaches the preview but no story | Full run |
| Anything in `bailOnChanges` | Full run, without tracing |
| Storybook's index does not report `importPath` | Full run |
| No stats file, or git cannot resolve `--since` | Exit 2, nothing runs |

The first row is the common one: a font, a `public/` asset, a Tailwind config,
something pulled in by `preview-head.html`. None of those are imported by
anything, so the graph cannot say what they affect, and the honest answer is
everything. Tell it once and it stops asking:

```json
{
  "onlyChanged": {
    "untraced": ["*.md", "docs/**", "e2e/**"],
    "bailOnChanges": [".storybook/**", "package.json", "tailwind.config.js"]
  }
}
```

`untraced` is "this cannot affect a story, ignore it". `bailOnChanges` is "this
can affect any story, do not bother tracing". The defaults for `bailOnChanges`
are the Storybook config directory, the package manifest, the lockfiles and
`.testingbot.json`; setting it to `[]` really does mean never bail. Here `*`
stops at a directory separator and `**` crosses it, unlike the story-id globs in
`include` and `exclude`.

Not being able to set the analysis up is a hard failure rather than a quiet full
run. If the stats file is missing or `--since` names a commit the repository does
not have, the command exits 2 without capturing anything, because running a
hundred times the work you asked for is a bill you did not agree to, and both
causes are one line to fix.

Unlike a shard, a traced run is not marked `"partial"`. It makes a real claim
about the stories it skipped: the change could not reach them. The JSON result
carries a `changeTrace` object with the base, the number of changed files and
the reason, so a CI job can see why a run was as small or as large as it was.

## Storybook's Testing widget

Results are published to Storybook's own status store, so you get sidebar icons
per story and a TestingBot row in the Testing widget with its own Run button,
next to any other test providers you have configured.

A first baseline shows as a warning rather than a pass. Nothing was compared,
and treating it as green would hide the one run where a wrong screenshot gets
frozen in as the truth.

The widget uses Storybook APIs that are still marked experimental. If a future
Storybook removes them the addon logs a warning, skips the registration, and the
panel keeps working unchanged.

## What works today

| Capability | Status |
| --- | --- |
| Tunnel lifecycle, port derivation, teardown | Working |
| Actionable errors for missing Java, bad credentials, exhausted plan or tunnel limit | Working |
| Browser and device picker from your account's live capability list | Working |
| Run by story, component or everything, with live progress and cancel | Working |
| Per-story `parameters.testingbot`: skip, waitForSelector, args, globals, queryParams | Working |
| Several viewport widths in one run, desktop only | Working |
| MDX docs and generated autodocs pages, opt in | Working |
| Splitting a run across CI machines with --shard-count and --shard-index | Working |
| Running only the stories a change can reach, with --only-changed | Working |
| Screenshots, pixel diffs, baselines, side by side review, approval | Working |
| Real Android over Playwright, real iOS over WebDriver | Working |
| Simulators and emulators, kept apart from physical hardware | Working |
| Hosted visual comparison on TestingBot, browsers and devices | Working |
| CLI with CI exit codes and JSON output | Working |
| Storybook Testing widget and sidebar statuses | Working |
| Firefox and WebKit on the grid | Blocked, see below |

Firefox and WebKit are configurable but do not currently connect over
Playwright. A session starts on the grid and is billed, but the handshake never
completes and the connect call times out. The same Firefox on the same account
drives fine over WebDriver, so this is a grid endpoint problem rather than an
addon one, and it is being tracked separately. Until it is fixed, use
chromium-family browsers on desktop: `chrome` and `edge`. Devices are
unaffected: real Android is Chrome, and real iOS does not go through Playwright
at all.

Two limits that are not bugs and will not be fixed here:

- Playwright does not drive real iOS devices. Its real-device support is Chrome
  on real Android, which this addon uses. Real iOS is reached through WebDriver
  and Mobile Safari instead, which is why the two device families take
  different code paths.
- Storybook's Vitest addon cannot run against a remote grid. Its orchestrator
  serves the tests from localhost, which is the one address the grid cannot
  reach. That is the reason this addon exists as a separate runner rather than
  as a Vitest configuration.

## Verified versions

The Storybook addon APIs this uses include experimental ones, so the versions
are pinned and re-verified rather than assumed.

| Package | Verified against |
| --- | --- |
| `storybook` | 10.5.10 |
| `testingbot-tunnel-launcher` | 1.1.19 |
| TestingBot Tunnel | 4.9 |

`experimental_serverChannel` is experimental by name and is applied at
`storybook/dist/core-server/index.js:11984` in 10.5.10. `npm test` fails loudly
if the surfaces this addon depends on disappear, so a Storybook upgrade that
breaks it is a visible test failure rather than a silently dead panel.

Frameworks this has been booted against: `@storybook/react-vite` and
`@storybook/react-webpack5`.

## Security

Two deliberate defences, both of which protect your account rather than your
machine:

- **A per-process nonce.** The preset injects a nonce into the manager document
  via `managerHead`, and every state-mutating channel event must carry it.
  Without this, any page you happened to visit could reach your running
  Storybook and start billable grid runs on your account.
- **Credentials stay in Node.** They are never sent to the manager, never put in
  manager state, and never logged. The panel is told only whether a usable pair
  exists and which source it came from.
- **One run at a time.** Every run costs grid minutes and a parallel session, so
  a second trigger while one is in flight is refused with a clear message rather
  than queued. Credentials entered in the panel are verified against TestingBot
  before anything is written to `.env`, so a forged event cannot write arbitrary
  content into your project.

## License

MIT
