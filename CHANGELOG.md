# Changelog

## 0.1.0 (unreleased)

First public release.

- Run stories from the Storybook panel, the toolbar button, Storybook's Testing
  widget or the `testingbot-storybook` CLI, on TestingBot browsers and devices,
  through a TestingBot Tunnel the addon starts and stops itself.
- Browser and device picker built from the account's live capability list:
  desktop Chrome and Edge, real Android over Playwright, real iOS over
  WebDriver, and simulators and emulators labelled as such.
- Local pixel comparison against PNG baselines in `.testingbot/baselines`, with
  side by side review and approval in the panel, or hosted comparison on
  TestingBot with `"visual": "hosted"`.
- Per-story `parameters.testingbot`, several widths per run, opt-in MDX and
  autodocs pages, `--shard-count`/`--shard-index` and `--only-changed` for CI,
  and a JSON result with CI exit codes.
- Hosted comparison forwards `threshold`, `ignoreRegions`, `ignoreSelectors` and
  `disableFreeze`.

Known limit: Firefox and WebKit do not connect over Playwright on the grid yet;
see "What works today" in the README.

## Releasing

1. Move the entries above under the new version and set `version` in
   `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`).
2. Merge to `main` with CI green.
3. Publish a GitHub release tagged `v<x.y.z>`. `.github/workflows/publish.yml`
   runs lint, typecheck, build and tests and publishes to npm with provenance
   through npm trusted publishing (no token). The trusted publisher for
   `@testingbot/storybook` must be configured on npmjs.com first.
