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
    theme: 'light',
  },

  /**
   * Declared so the addon's `globals` parameter has something real to switch.
   * Storybook drops a URL global that is not declared here or in
   * initialGlobals, and says so only in the page's own console, so a story
   * that switched an undeclared global would look green and render its
   * default.
   */
  globalTypes: {
    theme: { description: 'Light or dark', defaultValue: 'light' },
  },
}
