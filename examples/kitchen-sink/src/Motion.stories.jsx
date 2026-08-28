/**
 * Animation is the most common reason a visual test is flaky, and the reason
 * this addon takes every screenshot with Playwright's animations: 'disabled'.
 *
 * That option rewinds CSS animations and transitions to their first frame
 * before the capture, so a spinner is photographed at the same angle every
 * time. Both stories below animate continuously and both are stable to compare.
 * Delete the option from the runner and Spinner starts failing within a run or
 * two, which is the point of keeping them.
 *
 * What it does not cover is JavaScript-driven motion, requestAnimationFrame or
 * a canvas. Nothing can freeze those from the outside; a story that animates
 * that way has to freeze itself or be excluded.
 */

const spin = `
@keyframes tb-spin { to { transform: rotate(360deg); } }
@keyframes tb-pulse { 50% { opacity: 0.25; } }
`

export default {
  title: 'Motion/Animated',
}

export const Spinner = {
  render: () => (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <style>{spin}</style>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '3px solid #e8eaed',
          borderTopColor: '#1a73e8',
          animation: 'tb-spin 0.8s linear infinite',
        }}
      />
      <span style={{ font: '14px/1 system-ui, sans-serif', animation: 'tb-pulse 1.4s ease-in-out infinite' }}>
        Loading your account
      </span>
    </div>
  ),
}

/**
 * A transition rather than a keyframe animation, because the two are handled by
 * different parts of the same option and it is worth exercising both.
 */
export const HoverLift = {
  render: () => (
    <div
      style={{
        width: 220,
        padding: 20,
        borderRadius: 10,
        background: '#ffffff',
        border: '1px solid #dadce0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
        transition: 'box-shadow 240ms ease, transform 240ms ease',
        font: '14px/1.4 system-ui, sans-serif',
      }}
    >
      Cards that lift on hover are fine to screenshot. The transition is frozen
      at its resting state.
    </div>
  ),
}
