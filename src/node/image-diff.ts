import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

/**
 * Pixel comparison.
 *
 * Playwright's own toHaveScreenshot lives in @playwright/test, which this addon
 * deliberately does not depend on: the ticket requires playwright-core only so
 * that installing the addon never downloads a browser. pixelmatch is the same
 * algorithm family and about 200 lines.
 *
 * Anti-aliasing detection is on. Remote rendering differs subtly from local and
 * from run to run, and edge pixels are where that shows up first; counting them
 * as real differences would make every run red.
 */

export type DiffResult =
  | { equal: true; diffPixelRatio: 0 }
  | { equal: false; diffPixelRatio: number; diff: Buffer }
  | { equal: false; diffPixelRatio: 1; sizeMismatch: { baseline: string; actual: string } }

const DIFF_THRESHOLD = 0.1

export function compareImages (
  baseline: Buffer,
  actual: Buffer,
  maxDiffPixelRatio: number,
): DiffResult {
  const before = PNG.sync.read(baseline)
  const after = PNG.sync.read(actual)

  if (before.width !== after.width || before.height !== after.height) {
    // A size change is a real change, and pixelmatch cannot express it as a
    // ratio. Reporting it as its own case lets the UI say "the story got
    // taller" instead of "100% of pixels differ", which is true but useless.
    return {
      equal: false,
      diffPixelRatio: 1,
      sizeMismatch: {
        baseline: `${before.width}x${before.height}`,
        actual: `${after.width}x${after.height}`,
      },
    }
  }

  const diff = new PNG({ width: before.width, height: before.height })
  const changed = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
    threshold: DIFF_THRESHOLD,
    includeAA: false,
  })

  const total = before.width * before.height
  const diffPixelRatio = total === 0 ? 0 : changed / total

  if (diffPixelRatio <= maxDiffPixelRatio) {
    return { equal: true, diffPixelRatio: 0 }
  }

  return { equal: false, diffPixelRatio, diff: PNG.sync.write(diff) }
}
