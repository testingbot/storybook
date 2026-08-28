/**
 * A story taller than the viewport.
 *
 * This one is not decoration. The addon screenshots #storybook-root rather than
 * the page, which means something has to work out where that element is in the
 * document. A component that sits entirely above the fold cannot tell a
 * correct implementation from one that confuses document coordinates with
 * viewport coordinates: both crop the same rectangle. This one can.
 */

function Row ({ index }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '14px 18px',
        borderTop: index === 0 ? 'none' : '1px solid #e8eaed',
        font: '14px/1.4 system-ui, sans-serif',
      }}
    >
      <span>Line item {index + 1}</span>
      <span style={{ color: '#5f6368' }}>{((index + 1) * 12.5).toFixed(2)} EUR</span>
    </div>
  )
}

export default {
  title: 'Layout/TallCard',
  parameters: {
    // Centring a component three times the height of the viewport puts half of
    // it above the top of the page, where it cannot be screenshotted.
    layout: 'padded',
  },
}

export const Invoice = {
  render: () => (
    <div
      style={{
        width: 520,
        border: '1px solid #dadce0',
        borderRadius: 8,
        background: '#ffffff',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: 18, font: '600 18px/1 system-ui, sans-serif' }}>Invoice 2026-0042</div>
      {Array.from({ length: 40 }, (_, index) => (
        <Row key={index} index={index} />
      ))}
    </div>
  ),
}
