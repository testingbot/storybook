/**
 * Per-story configuration, read from Storybook's own `parameters`.
 *
 * TB-353. Until now the only way to say anything about a single story was an
 * `exclude` glob in `.testingbot.json`, which lives in another file from the
 * story it is about and goes stale silently when the story is renamed. A
 * parameter lives next to the story and moves with it:
 *
 *   Button.parameters = { testingbot: { skip: true } }
 *
 * Storybook's `/index.json` does not carry parameters, so they cannot be read
 * over HTTP before the run. They only exist inside the preview, which means the
 * only place to ask is a browser that already has the preview loaded. The
 * addon has one of those per target, so each target asks once, on the iframe
 * page, before its first story. The cost is one page load per target.
 *
 * This is the same mechanism @percy/storybook uses (src/utils.js, around
 * `__STORYBOOK_PREVIEW__.extract`), arrived at for the same reason.
 */

import { buildArgsParam } from './story-args.js'
import type { StoryEntry } from './types.js'

/** The parameter key. Namespaced, because a story's parameters are shared with every other addon. */
export const PARAMETER_KEY = 'testingbot'

export type StoryParameters = {
  /** Do not screenshot this story on any target. */
  skip?: boolean
  /** Wait for this selector before screenshotting, on top of the usual settle wait. */
  waitForSelector?: string
  /**
   * How long `waitForSelector` may take, in milliseconds. Defaults to the
   * runner's own selector timeout.
   *
   * Deliberately not called `waitForTimeout`, which is what @percy/storybook
   * calls a flat delay before the snapshot. Sharing the name for a different
   * meaning would quietly change the behaviour of anyone porting a config.
   */
  waitTimeout?: number
  /** Render the story with these args instead of its defaults. */
  args?: Record<string, unknown>
}

export type ParameterMap = Record<string, StoryParameters>

const KNOWN_KEYS = new Set(['skip', 'waitForSelector', 'waitTimeout', 'args'])

/**
 * Runs inside the page. Kept as source text rather than a function because it
 * has to reach two drivers: Playwright evaluates it as an expression, and
 * WebDriver posts it as a script body.
 *
 * Returning null rather than {} when there is no preview to read is the point
 * of the distinction: "this Storybook does not expose a store we understand" is
 * a thing worth telling the developer about, and "no story sets a parameter" is
 * not.
 */
const EXTRACT_BODY = `
  var preview = window.__STORYBOOK_PREVIEW__;

  if (!preview || typeof preview.extract !== 'function') return null;
  if (typeof preview.ready === 'function') await preview.ready();

  var stories = await preview.extract();
  var out = {};

  Object.keys(stories || {}).forEach(function (key) {
    var story = stories[key];
    var params = story && story.parameters && story.parameters[${JSON.stringify(PARAMETER_KEY)}];

    if (params && typeof params === 'object') out[story.id || key] = params;
  });

  return out;
`

/** For page.evaluate, which takes an expression and awaits what it returns. */
export const EXTRACT_EXPRESSION = `(async () => {${EXTRACT_BODY}})()`

/**
 * For WebDriver's /execute/async, which hands the script a callback as its last
 * argument and has no other way to wait for a promise.
 *
 * A rejection is reported as a value rather than thrown, because a script that
 * throws inside the callback chain leaves the request hanging until the command
 * timeout, and a Storybook we cannot read is not worth a sixty second stall.
 */
export const EXTRACT_ASYNC_SCRIPT = `
  var done = arguments[arguments.length - 1];

  (async function () {${EXTRACT_BODY}})().then(
    function (value) { done({ value: value }); },
    function (error) { done({ error: String((error && error.message) || error) }); },
  );
`

/**
 * Validates what came back from a page.
 *
 * The page is not trusted to have sent the right shape: it ran arbitrary
 * project code, and a parameter is whatever the developer typed. Anything
 * unrecognised is dropped and named, because a `waitforSelector` that silently
 * does nothing is the kind of typo that costs an afternoon.
 */
export function toParameterMap (raw: unknown): { params: ParameterMap; warnings: string[] } {
  const params: ParameterMap = {}
  const warnings: string[] = []

  if (raw === null || raw === undefined) {
    return { params, warnings: [] }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { params, warnings: ['Storybook returned story parameters in a shape this addon does not understand.'] }
  }

  for (const [storyId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue

    const entry: StoryParameters = {}

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!KNOWN_KEYS.has(key)) {
        warnings.push(`${storyId}: "${key}" is not a ${PARAMETER_KEY} parameter and was ignored.`)
        continue
      }

      if (key === 'skip') {
        if (typeof item !== 'boolean') {
          warnings.push(`${storyId}: "skip" must be true or false.`)
          continue
        }

        entry.skip = item
      }

      if (key === 'waitForSelector') {
        if (typeof item !== 'string' || !item.trim()) {
          warnings.push(`${storyId}: "waitForSelector" must be a non-empty selector.`)
          continue
        }

        entry.waitForSelector = item.trim()
      }

      if (key === 'waitTimeout') {
        if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0) {
          warnings.push(`${storyId}: "waitTimeout" must be a positive number of milliseconds.`)
          continue
        }

        entry.waitTimeout = item
      }

      if (key === 'args') {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          warnings.push(`${storyId}: "args" must be an object.`)
          continue
        }

        entry.args = item as Record<string, unknown>
      }
    }

    if (Object.keys(entry).length > 0) params[storyId] = entry
  }

  return { params, warnings }
}

/**
 * Splits the run's stories into the ones to screenshot and the ones that asked
 * to be left out.
 *
 * The skipped ones are returned rather than dropped for the same reason
 * runOnGrid reports skipped targets: a run that quietly covered less than it
 * was asked to would report green for something nobody looked at.
 */
export function partitionSkipped (
  stories: StoryEntry[],
  params: ParameterMap,
): { run: StoryEntry[]; skipped: StoryEntry[] } {
  const run: StoryEntry[] = []
  const skipped: StoryEntry[] = []

  for (const story of stories) {
    (params[story.id]?.skip === true ? skipped : run).push(story)
  }

  return { run, skipped }
}

/**
 * The iframe URL for one story, with its args if it asked for any.
 *
 * Args do not go into the baseline key. The key is the story id, and a story
 * that always renders with the same args always renders the same way; adding
 * them would only churn every baseline the first time someone reformatted
 * their config.
 */
export function storyUrl (
  devServerUrl: string,
  storyId: string,
  parameters: StoryParameters | undefined,
): { url: string; rejected: string[] } {
  const base = `${devServerUrl.replace(/\/$/, '')}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`

  if (!parameters?.args || Object.keys(parameters.args).length === 0) {
    return { url: base, rejected: [] }
  }

  const { param, rejected } = buildArgsParam(parameters.args)

  // Not encodeURIComponent: Storybook's own toolbar writes this parameter
  // unencoded, and its parser splits on the literal ";" and ":" that encoding
  // would hide.
  return { url: param ? `${base}&args=${param}` : base, rejected }
}
