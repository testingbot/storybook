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
real iPhone and one real Pixel. Cutting it to Chrome alone makes the run five times faster
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

The two device entries are physical hardware, which is what `realDevice` means
and what the addon writes by default. Do not assume a device name in
`https://api.testingbot.com/v1/browsers` is a phone: every iOS entry in that
list is a simulator, keyed by the macOS version hosting it, and its Android
entries are emulators unless they say `REAL_ANDROID`. Physical hardware is
listed at `https://api.testingbot.com/v1/devices`, with an `available` flag per
device.

The addon's picker now offers both and says which is which. Simulators are
genuinely useful while iterating, and they get their own baseline folder because
they do not render like the phone. If a device target hangs for five minutes
rather than failing, the likely cause is asking for hardware that is not in the
fleet.

## Why macOS is Sequoia and not Sonoma

The SONOMA pool is not a single machine image. Some hosts run macOS 14.5.0 and
some run 14.6.1, and the two lay text out one pixel apart: 14.6.1 builds a 19px
line box where every other macOS builds a 20px one, from identical font metrics.
Which host you land on is chance, so the same unchanged page comes back one of
two ways and the text-heavy stories differ by about 1.3% roughly half the time.

That is not something to tune around. Sequoia (15.6.0) and Tahoe (26.3.1) are
each a single image, and both agree with macOS 14.5.0, so this target gets the
same macOS font rendering coverage without the coin flip. Tracked as TB-309, and
SONOMA goes back the day the pool is level.

Worth knowing in general: `platform` names a major release, not a machine. If a
macOS target is bimodal and everything else is stable, read the point release
before suspecting your own code:

```js
(await navigator.userAgentData.getHighEntropyValues(['platformVersion'])).platformVersion
```

## Baselines are not committed here

A baseline is only meaningful next to the machine that produced it, and these
come from the grid. This example is run on demand rather than in CI, so there is
nothing to protect against drift and a committed set of images would go stale
without anyone noticing. Your own project should do the opposite: commit them,
and regenerate them from the grid rather than from a laptop. `examples/testingbot-storybook.yml`
shows how.
