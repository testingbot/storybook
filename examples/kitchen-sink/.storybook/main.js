/**
 * The Storybook this addon is developed against.
 *
 * Everything the addon needs is in the one addon entry. There is no separate
 * preset import: Storybook 10 resolves "@testingbot/storybook" to the package's
 * ./preset export by itself, and adding the preset by hand as well registers
 * the addon twice.
 */

/** @type {import('@storybook/react-vite').StorybookConfig} */
export default {
  stories: ['../src/**/*.stories.jsx'],

  addons: [
    // Configuration lives in .testingbot.json rather than here, so the CLI and
    // the panel read the same file. Options set here would win over it, which
    // is the right default for a project that never uses the CLI and the wrong
    // one for this example.
    '@testingbot/storybook',
  ],

  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
}
