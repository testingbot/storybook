/**
 * A plain button. Small on purpose: the screenshot is cropped to the story
 * element, so the tolerance is a fraction of this component rather than of a
 * mostly empty 1280x720 page.
 */
export function Button ({ variant = 'primary', disabled = false, children }) {
  const palette = {
    primary: { background: '#1a73e8', color: '#ffffff', border: '1px solid #1a73e8' },
    secondary: { background: '#ffffff', color: '#1a73e8', border: '1px solid #1a73e8' },
    danger: { background: '#d93025', color: '#ffffff', border: '1px solid #d93025' },
  }[variant]

  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        ...palette,
        opacity: disabled ? 0.5 : 1,
        font: '500 14px/1 system-ui, sans-serif',
        padding: '10px 18px',
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}
