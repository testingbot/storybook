/**
 * The two settings below are what make a screenshot of this Storybook worth
 * comparing to another one taken five minutes later.
 */
export default {
  parameters: {
    // A story that renders on white and a story that renders on Storybook's
    // default light background differ by every pixel of their padding. Pin it.
    backgrounds: {
      options: {
        white: { name: 'white', value: '#ffffff' },
      },
    },
    layout: 'centered',
  },

  initialGlobals: {
    backgrounds: { value: 'white' },
  },
}
