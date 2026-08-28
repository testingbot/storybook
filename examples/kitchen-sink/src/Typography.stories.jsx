/**
 * Text is where cross browser testing earns its keep.
 *
 * A button is a rectangle and renders the same everywhere. A paragraph breaks
 * at different words, hyphenates differently and antialiases differently on
 * macOS, Windows and a real iPhone. If any story in this Storybook is going to
 * catch something a local headless Chromium would not, it is this one.
 */

export default {
  title: 'Basics/Typography',
  parameters: { layout: 'padded' },
}

const Sample = ({ family, size, weight }) => (
  <div style={{ maxWidth: 460, font: `${weight} ${size}/1.5 ${family}` }}>
    <p style={{ margin: '0 0 12px' }}>
      Portez ce vieux whisky au juge blond qui fume, and pack my box with five
      dozen liquor jugs.
    </p>
    <p style={{ margin: 0, color: '#5f6368' }}>
      Numerals 0123456789, punctuation ffi fl &mdash; typographic quotes
      &ldquo;like this&rdquo;.
    </p>
  </div>
)

export const SystemUI = { render: () => <Sample family="system-ui, sans-serif" size="16px" weight="400" /> }
export const Serif = { render: () => <Sample family="Georgia, serif" size="17px" weight="400" /> }
export const Monospace = { render: () => <Sample family="ui-monospace, monospace" size="14px" weight="400" /> }
export const Heavy = { render: () => <Sample family="system-ui, sans-serif" size="22px" weight="700" /> }
