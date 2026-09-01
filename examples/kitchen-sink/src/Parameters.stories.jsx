import { useEffect, useState } from 'react'

import { Button } from './Button.jsx'

/**
 * TB-353: the three per-story parameters, one story each.
 *
 * These exist to be run against the grid, not to look at. Each one fails
 * visibly if the parameter is not honoured: the skipped story renders a red
 * banner, the args story renders its default label, and the late story renders
 * a spinner instead of its content.
 */
export default {
  title: 'Parameters/Story',
}

export const Skipped = {
  parameters: { testingbot: { skip: true } },
  render: () => (
    <p style={{ background: '#d93025', color: '#fff', font: '500 16px system-ui', padding: 16 }}>
      This story asked to be skipped. A baseline for it means skip was ignored.
    </p>
  ),
}

/**
 * The story's own args say "Save changes". The parameter overrides them, so a
 * screenshot reading "Save changes" means the args parameter did nothing.
 */
export const WithArgs = {
  args: { variant: 'primary', children: 'Save changes' },
  parameters: { testingbot: { args: { children: 'Overridden by parameters' } } },
  render: (args) => <Button {...args} />,
}

/** Renders nothing worth screenshotting for a second, then the real content. */
function Late () {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 1000)

    return () => clearTimeout(timer)
  }, [])

  if (!ready) {
    return <p style={{ font: '400 16px system-ui', color: '#888' }}>Loading...</p>
  }

  return (
    <p data-testid="loaded" style={{ font: '400 16px system-ui' }}>
      Loaded. A screenshot reading &quot;Loading...&quot; means waitForSelector did nothing.
    </p>
  )
}

export const WaitsForContent = {
  parameters: { testingbot: { waitForSelector: '[data-testid="loaded"]' } },
  render: () => <Late />,
}
