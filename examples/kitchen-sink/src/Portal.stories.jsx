import { createPortal } from 'react-dom'

/**
 * The documented failure mode, kept as a runnable story rather than a paragraph
 * in the README.
 *
 * A modal rendered through a portal is not inside #storybook-root, so cropping
 * to the story element photographs the empty space the modal left behind. There
 * is no clever fix: either compare the whole page, or do not compare this
 * story.
 *
 * .testingbot.json excludes it, which is the right answer here because turning
 * on fullPage for one story would turn it on for all of them and put every
 * other story's tolerance back on a 1280x720 denominator. A project whose
 * components are mostly modals should make the opposite choice.
 */

export default {
  title: 'Escapes/Portal',
}

export const Modal = {
  render: () => (
    <>
      <span style={{ font: '14px/1 system-ui, sans-serif', color: '#5f6368' }}>
        The story root. The dialog below is not in it.
      </span>
      {createPortal(
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(32,33,36,0.5)',
          }}
        >
          <div
            style={{
              width: 320,
              padding: 24,
              borderRadius: 10,
              background: '#ffffff',
              font: '14px/1.5 system-ui, sans-serif',
            }}
          >
            <strong style={{ display: 'block', marginBottom: 8 }}>Delete this project?</strong>
            This dialog renders into document.body, outside the story root.
          </div>
        </div>,
        document.body,
      )}
    </>
  ),
}
