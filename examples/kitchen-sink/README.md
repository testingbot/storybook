# kitchen-sink

The Storybook this addon is developed against. It is not published and it is
not a template to copy; it is the thing that proves the addon works before a
release goes out.

Every story here earns its place by being awkward in a specific way.

| Story | What it is there to catch |
| --- | --- |
| `Basics/Button` | The ordinary case. If these five fail, everything is broken. |
| `Basics/Button > LongLabel` | Wrapping. Looks fine on a desktop, breaks on a phone. |
| `Layout/TallCard` | Taller than the viewport, so a screenshot that confuses document coordinates with viewport coordinates crops the wrong rectangle. A story that fits above the fold cannot tell the two apart. |
| `Basics/Typography` | Font rendering, line breaking and antialiasing, which is the one thing a local headless Chromium genuinely cannot tell you about. |
| `Motion/Animated` | A spinner and a transition. Both animate continuously and both must still be stable, because captures use Playwright's `animations: 'disabled'`. |
| `Escapes/Portal` | Renders outside `#storybook-root`. Excluded in `.testingbot.json`, and the comment in the story says why. |

## Running it

```sh
npm install                       # from the repository root, then here
npm run storybook                 # look at it
```

To run the stories on the grid you need credentials in `TB_KEY` and `TB_SECRET`,
or in `~/.testingbot`:

```sh
npm test                          # builds Storybook, serves it, runs everything
npm run test:serve                # against a Storybook you already have running
```

The first run has nothing to compare against, so it writes
`.testingbot/baselines` and passes. Look at those images before you commit them:
they become the definition of correct.

## Why there is a vite.config.js

`@storybook/react-vite` no longer brings a React plugin with it. Without
`@vitejs/plugin-react` the `.jsx` files compile with the classic JSX runtime and
every story dies at runtime with "React is not defined", which the addon now
reports as a render failure rather than as a screenshot timeout.

## Why the target list looks like that

The addon has two transports underneath and both need exercising on every
change:

- Desktop browsers and real Android devices go through Playwright.
- Real iOS devices go through WebDriver, because Playwright has no iOS backend.

So the list is Chrome on Windows and on macOS (same engine, different font
rendering, which is most of what these stories catch), Edge on Windows, one
iPhone and one Pixel. Cutting it to Chrome alone makes the run five times faster
and stops testing half the addon.

There is no Firefox or Safari here, and their absence is not an oversight.
TestingBot's Playwright endpoint currently accepts a Firefox or WebKit session,
bills for it, and never completes the handshake, so a run that included them
would hang rather than fail. Tracked as TB-272. The same browsers work over
WebDriver, and they go back in this file the day it closes.

Every device name, platform and version above was checked against
`https://api.testingbot.com/v1/browsers`, which is the list the addon's own
catalogue is built from. Versions are exact strings: `"26.0"` is a real iOS
version and `"26"` is not.

That list is necessary and not sufficient for real devices. It offered
iPhone 15 on iOS 17.0, and asking for it timed out after five minutes with no
session, because the physical pool has no such device. The list that answers
that question is `https://api.testingbot.com/v1/devices`, where each entry
carries an `available` flag. If a device target hangs rather than failing, look
there first. Tracked as TB-310.

## Chrome on macOS is expected to be noisy

macOS Chrome on the grid does not rasterise text the same way twice. The same
unchanged page comes back one of two ways, and the two differ by about 1.3% on
the text-heavy stories. Six consecutive runs of `Basics/Typography > Serif`
went differ, match, match, differ, differ, match, and when it differs it is
always exactly 1.283%. Four of those runs reported the identical
`SONOMA | googlechrome 150` from the API, so it is not a version drifting
underneath us. Tracked as TB-309.

It stays in the target list anyway. This example exists to exercise the addon
against reality, and a grid that renders text two ways is the reality the addon
ships into. Expect `chrome_latest_sonoma` to report a handful of differences on
a rerun, look at the diff images to confirm they are the text stories, and do
not raise `maxDiffPixelRatio` to silence it: it is one number for the whole
project today, so raising it to cover macOS would blind Windows, Edge and the
Pixel as well. TB-311 is the per-target tolerance that would let this be
configured honestly.

## Baselines are not committed here

A baseline is only meaningful next to the machine that produced it, and these
come from the grid. This example is run on demand rather than in CI, so there is
nothing to protect against drift and a committed set of images would go stale
without anyone noticing. Your own project should do the opposite: commit them,
and regenerate them from the grid rather than from a laptop. `examples/testingbot-storybook.yml`
shows how.
